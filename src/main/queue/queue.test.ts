import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { QueueItemStatus, QueueOptions, QueueState } from '@shared/queue-types'
import type { RunSummary, StartRunParams } from '@shared/runner-types'
import { RunManager, type RunContext } from '../cli/runner'
import { readRun } from '../cli/runs'
import { queueFile, requireConcurrency, requireEnqueueInput, requireItemId, TailorQueue, type QueueDeps } from './queue'

const FAKE = join(__dirname, '../cli/fixtures/fake-claude.mjs')
const options: QueueOptions = { coverLetter: false, dateStyle: 'right' }

let ws: string
let jobs: Map<string, Job>
let manager: RunManager
let queue: TailorQueue
let states: QueueState[]
let started: { params: StartRunParams; at: number }[]
let tailored: string[]
let fetched: string[]

function job(id: string, over: Partial<Job> = {}): Job {
  const [source, sourceId] = id.split(':') as [Job['source'], string]
  return {
    id,
    source,
    sourceId,
    title: `Engineer ${sourceId}`,
    company: `Co ${sourceId}`,
    location: '',
    remote: true,
    salary: '',
    postedAt: null,
    url: `https://jobs.example.com/${sourceId}`,
    boardUrl: null,
    description: 'Build APIs.',
    descriptionComplete: true,
    tags: [],
    fetchedAt: '2026-09-30T00:00:00.000Z',
    ...over
  }
}

function ctx(): RunContext {
  return {
    workspace: ws,
    skillDir: '/skills/resume-tailor',
    sandbox: { workspace: ws, skillDir: '/skills/resume-tailor', venvDir: '/venv', texRoot: null },
    command: process.execPath,
    commandPrefixArgs: [FAKE],
    env: { ...process.env },
    systemPrompt: 'test'
  }
}

function deps(over: Partial<QueueDeps> = {}): QueueDeps {
  return {
    workspace: async () => ws,
    findJob: async (_ws, id) => jobs.get(id) ?? [...jobs.values()].find((j) => j.aliases?.includes(id)) ?? null,
    fetchDetails: async (_ws, id) => {
      fetched.push(id)
      const j = jobs.get(id)!
      if (j.source === 'indeed') throw new Error('Indeed needs a human check.')
      const full = { ...j, description: 'Full posting text.', descriptionComplete: true }
      jobs.set(id, full)
      return full
    },
    markTailored: async (_ws, id) => tailored.push(id),
    start: async (params) => {
      started.push({ params, at: Date.now() })
      return manager.start(params, ctx())
    },
    stopRun: (id, workspace) => manager.stopAny(workspace, id),
    reply: (id, text) => manager.reply(id, text, async () => ctx()),
    onChange: (s) => states.push(s),
    spawnGapMs: 0,
    retryDelayMs: 50,
    ...over
  }
}

/** Waits until the latest queue state satisfies `pred`. */
async function until(pred: (s: QueueState) => boolean, ms = 5000): Promise<QueueState> {
  const t0 = Date.now()
  for (;;) {
    const s = queue.state()
    if (pred(s)) return s
    if (Date.now() - t0 > ms) throw new Error(`timeout; statuses ${s.items.map((i) => i.status).join(',')}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const statuses = (s: QueueState) => s.items.map((i) => i.status)
const all = (st: QueueItemStatus) => (s: QueueState) => s.items.length > 0 && s.items.every((i) => i.status === st)

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-queue-'))
  jobs = new Map()
  states = []
  started = []
  tailored = []
  fetched = []
  manager = new RunManager({ onEvent: () => undefined, onRun: (r: RunSummary) => queue.onRun(r) })
  queue = new TailorQueue(deps())
})

afterEach(async () => {
  await queue.shutdown()
  manager.stopAll()
  await manager.whenIdle()
  await rm(ws, { recursive: true, force: true })
})

describe('TailorQueue', () => {
  it('starts every job, frees the slot at the approval step and marks each job tailored once', async () => {
    for (const id of ['url:a', 'url:b', 'url:c']) jobs.set(id, job(id))
    const res = await queue.enqueue({ jobIds: ['url:a', 'url:b', 'url:c'], options, concurrency: 2 })
    expect(res.added).toBe(3)
    expect(res.state.paused).toBe(false)
    const s = await until(all('needs-reply'))
    expect(s.items.every((i) => i.runId)).toBe(true)
    expect(tailored.sort()).toEqual(['url:a', 'url:b', 'url:c'])
    expect(started[0].params).toMatchObject({ role: 'Engineer a', company: 'Co a', jobId: 'a', source: 'url' })
    expect(started[0].params.jobDescription).toContain('Build APIs.')
  })

  it('gives every job of one request the same batch id and records it on the runs (#44)', async () => {
    for (const id of ['url:a', 'url:b', 'url:c']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a', 'url:b'], options, concurrency: 2 })
    await queue.enqueue({ jobIds: ['url:c'], options })
    const s = await until(all('needs-reply'))
    const [a, b, c] = s.items.map((i) => i.batchId)
    expect(a).toMatch(/^b-\d{8}-\d{6}-[0-9a-f]{6}$/)
    expect(b).toBe(a)
    expect(c).not.toBe(a)
    expect(started.map((x) => x.params.batchId).sort()).toEqual([a, a, c].sort())
    expect((await readRun(ws, s.items[0].runId!)).params.batchId).toBe(a)
  })

  it('never has more than `concurrency` runs working at once', async () => {
    for (const id of ['url:a', 'url:b', 'url:c']) jobs.set(id, job(id))
    // SLOW keeps each first turn busy for 300 ms.
    await queue.enqueue({ jobIds: ['url:a', 'url:b', 'url:c'], options: { ...options, notes: 'SLOW' }, concurrency: 2 })
    let peak = 0
    const t0 = Date.now()
    while (!all('needs-reply')(queue.state()) && Date.now() - t0 < 5000) {
      peak = Math.max(peak, queue.state().items.filter((i) => i.status === 'running' || i.status === 'preparing').length)
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(all('needs-reply')(queue.state())).toBe(true)
    expect(peak).toBe(2)
    // The third job only started after a slot freed up.
    expect(states.some((st) => statuses(st).join() === 'needs-reply,running,queued' || statuses(st).join() === 'running,needs-reply,queued')).toBe(true)
  })

  it('spaces spawns by the spawn gap', async () => {
    queue = new TailorQueue(deps({ spawnGapMs: 150 }))
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a', 'url:b'], options, concurrency: 2 })
    await until(all('needs-reply'))
    expect(started[1].at - started[0].at).toBeGreaterThanOrEqual(140)
  })

  it('fails a job whose description cannot be read without spawning, and carries on', async () => {
    jobs.set('indeed:x', job('indeed:x', { descriptionComplete: false }))
    jobs.set('hiring.cafe:y', job('hiring.cafe:y', { descriptionComplete: false }))
    jobs.set('url:z', job('url:z'))
    await queue.enqueue({ jobIds: ['indeed:x', 'hiring.cafe:y', 'url:z'], options })
    const s = await until((st) => statuses(st).join() === 'failed,needs-reply,needs-reply')
    expect(s.items[0].error).toMatch(/human check.*Paste a job/)
    expect(started.map((x) => x.params.jobId)).toEqual(['y', 'z'])
    // The summary-only hiring.cafe job had its full posting fetched first.
    expect(fetched).toEqual(['hiring.cafe:y'])
    expect(started[0].params.jobDescription).toContain('Full posting text.')
    expect(tailored).not.toContain('indeed:x')
  })

  it('pauses when Claude cannot be started (e.g. signed out), leaving the other jobs queued', async () => {
    let signedIn = false
    queue = new TailorQueue(
      deps({
        start: async (params) => {
          if (!signedIn) throw new Error('Claude Code is not signed in. Run claude auth login in a terminal.')
          started.push({ params, at: Date.now() })
          return manager.start(params, ctx())
        }
      })
    )
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a', 'url:b'], options })
    const s = await until((st) => st.paused && st.items[0].status === 'failed')
    expect(s.items[0].error).toMatch(/not signed in/)
    expect(s.items[1].status).toBe('queued')
    expect(tailored).toEqual([])
    signedIn = true
    await queue.retry(s.items[0].id)
    await until(all('needs-reply'))
    expect(started).toHaveLength(2)
  })

  it('isolates a crashing run and keeps the others going', async () => {
    jobs.set('url:a', job('url:a'))
    jobs.set('url:b', job('url:b'))
    await queue.enqueue({ jobIds: ['url:a'], options: { ...options, notes: 'CRASH' } })
    await queue.enqueue({ jobIds: ['url:b'], options })
    const s = await until((st) => statuses(st).join() === 'failed,needs-reply')
    expect(s.items[0].error).toContain('boom: simulated failure')
    expect(s.items[0].attempts).toBe(0)
  })

  it('retries a first-turn rate limit once, automatically, and not a second time', async () => {
    jobs.set('url:a', job('url:a'))
    await queue.enqueue({ jobIds: ['url:a'], options: { ...options, notes: 'RATE_LIMIT' } })
    const s = await until((st) => st.items[0].status === 'failed' && st.items[0].attempts === 1)
    expect(started).toHaveLength(2)
    expect(s.items[0].error).toMatch(/temporarily limiting requests/)
    expect(states.some((st) => st.items[0].status === 'queued' && st.items[0].attempts === 1)).toBe(true)
  })

  it('cancels a queued job without spawning it and a running one by stopping its process', async () => {
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a', 'url:b'], options: { ...options, notes: 'SLOW' }, concurrency: 1 })
    const running = await until((st) => st.items[0].status === 'running')
    await queue.cancel(running.items[1].id)
    await queue.cancel(running.items[0].id)
    await manager.whenIdle()
    const s = queue.state()
    expect(statuses(s)).toEqual(['cancelled', 'cancelled'])
    expect(started).toHaveLength(1)
    expect(manager.isLive(running.items[0].runId!)).toBe(false)
  })

  it('holds a reply while the queue is full, then sends it before starting new jobs', async () => {
    for (const id of ['url:a', 'url:b', 'url:c']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a'], options, concurrency: 1 })
    const first = await until(all('needs-reply'))
    const runA = first.items[0].runId!
    await queue.enqueue({ jobIds: ['url:b'], options: { ...options, notes: 'SLOW' } })
    await until((st) => st.items[1].status === 'running')
    await queue.enqueue({ jobIds: ['url:c'], options })
    // B holds the only slot: A's answer waits instead of making two runs work at once.
    expect(await queue.reply(runA, 'Approved.')).toBe('held')
    expect(queue.state().items[0]).toMatchObject({ status: 'queued', pendingReply: 'Approved.' })
    let peak = 0
    const t0 = Date.now()
    while (!all('needs-reply')(queue.state()) && Date.now() - t0 < 5000) {
      peak = Math.max(peak, queue.state().items.filter((i) => i.status === 'running' || i.status === 'preparing').length)
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(all('needs-reply')(queue.state())).toBe(true)
    expect(peak).toBe(1)
    // A's reply went out as soon as B's turn ended, before C started.
    const aRunning = states.findIndex((st) => st.items[0].status === 'running' && st.items[1]?.status === 'needs-reply')
    const cStarted = states.findIndex((st) => st.items[2]?.status === 'preparing')
    expect(aRunning).toBeGreaterThan(-1)
    expect(aRunning).toBeLessThan(cStarted)
    await manager.flush(runA)
    expect(manager.liveRun(runA)?.costUsd).toBeCloseTo(0.02)
    expect(queue.state().items[0].pendingReply).toBeUndefined()
  })

  it('sends a reply at once when a slot is free, and leaves runs outside the queue alone', async () => {
    jobs.set('url:a', job('url:a'))
    await queue.enqueue({ jobIds: ['url:a'], options })
    const { items } = await until(all('needs-reply'))
    const sent = await queue.reply(items[0].runId!, 'Approved.')
    expect(sent).toMatchObject({ id: items[0].runId, status: 'running' })
    await until(all('needs-reply'))
    const outside = await manager.start({ jobDescription: 'x', coverLetter: false, dateStyle: 'right' }, ctx())
    expect(await queue.reply(outside.id, 'hi')).toBeNull()
  })

  it('cancelling a job with a held reply stops its waiting run', async () => {
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a'], options, concurrency: 1 })
    const runA = (await until(all('needs-reply'))).items[0].runId!
    await queue.enqueue({ jobIds: ['url:b'], options: { ...options, notes: 'SLOW' } })
    await until((st) => st.items[1].status === 'running')
    expect(await queue.reply(runA, 'Approved.')).toBe('held')
    await queue.cancel(queue.state().items[0].id)
    expect(queue.state().items[0]).toMatchObject({ status: 'cancelled' })
    expect(queue.state().items[0].pendingReply).toBeUndefined()
    await until((st) => st.items[1].status === 'needs-reply')
    expect(manager.isLive(runA)).toBe(false)
  })

  it('cancel all, retry, remove and clear finished', async () => {
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id))
    await queue.setPaused(true)
    await queue.enqueue({ jobIds: ['url:a', 'url:b'], options })
    await queue.cancelAll()
    await manager.whenIdle()
    expect(statuses(queue.state())).toEqual(['cancelled', 'cancelled'])
    const [a, b] = queue.state().items
    await queue.retry(a.id)
    const retried = await until((st) => st.items[0].status === 'needs-reply')
    expect(retried.items[0].attempts).toBe(1)
    await expect(queue.retry(retried.items[0].id)).rejects.toThrow(/failed or cancelled/)
    await queue.remove(b.id)
    expect(queue.state().items).toHaveLength(1)
    await queue.cancel(a.id)
    await queue.clearFinished()
    expect(queue.state().items).toHaveLength(0)
  })

  it('dedupes by canonical job and skips dismissed and unknown jobs', async () => {
    jobs.set('hiring.cafe:a', job('hiring.cafe:a', { aliases: ['indeed:a2'] }))
    jobs.set('url:gone', job('url:gone', { dismissed: true }))
    await queue.setPaused(true)
    const first = await queue.enqueue({ jobIds: ['hiring.cafe:a', 'indeed:a2', 'url:gone', 'url:nope'], options })
    expect(first.added).toBe(1)
    expect(first.skipped.map((s) => s.reason)).toEqual([
      'Already in the queue.',
      'Dismissed jobs are not tailored.',
      'This job is no longer saved.'
    ])
    const again = await queue.enqueue({ jobIds: ['hiring.cafe:a'], options })
    expect(again.added).toBe(0)
  })

  it('persists the queue and reloads it paused, with interrupted jobs failed and retryable', async () => {
    for (const id of ['url:a', 'url:b', 'url:c']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a'], options })
    await until(all('needs-reply'))
    await queue.enqueue({ jobIds: ['url:b', 'url:c'], options: { ...options, notes: 'SLOW' }, concurrency: 1 })
    await until((st) => st.items[1].status === 'running')
    // As on quit: the queue stops following its runs, then the processes are killed.
    await queue.shutdown()
    manager.stopAll()
    await manager.whenIdle()
    const saved = JSON.parse(await readFile(queueFile(ws), 'utf8'))
    expect(saved).toMatchObject({ version: 1, concurrency: 1 })

    queue = new TailorQueue(deps())
    const s = await queue.sync()
    expect(s.paused).toBe(true)
    expect(s.concurrency).toBe(1)
    expect(statuses(s)).toEqual(['needs-reply', 'failed', 'queued'])
    expect(s.items[1].error).toMatch(/closed while/)
    // Paused: nothing starts on its own.
    await new Promise((r) => setTimeout(r, 50))
    expect(statuses(queue.state())).toEqual(['needs-reply', 'failed', 'queued'])
  })

  it('starts a job only in its own workspace, even if another one is opened while it starts', async () => {
    const first = ws
    const other = await mkdtemp(join(tmpdir(), 'huntgry-queue-other-'))
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    queue = new TailorQueue(
      deps({
        start: async (_params, _agent, workspace) => {
          seen.push(workspace)
          await gate
          // As startTailorRun does when the open workspace is no longer the job's.
          if (ws !== workspace) throw new Error('Another workspace was opened while this job was starting.')
          throw new Error('unreachable')
        }
      })
    )
    jobs.set('url:a', job('url:a'))
    await queue.enqueue({ jobIds: ['url:a'], options })
    await until((st) => st.items[0]?.status === 'preparing')
    ws = other
    await queue.sync()
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual([first])
    // The old job's refusal does not leak into the new workspace's queue.
    expect(queue.state().items).toEqual([])
    ws = first
    await rm(other, { recursive: true, force: true })
  })

  it('reloads when the workspace changes', async () => {
    jobs.set('url:a', job('url:a'))
    await queue.setPaused(true)
    await queue.enqueue({ jobIds: ['url:a'], options })
    await queue.setPaused(true)
    await queue.flush()
    const other = await mkdtemp(join(tmpdir(), 'huntgry-queue-other-'))
    const first = ws
    ws = other
    expect((await queue.sync()).items).toHaveLength(0)
    ws = first
    expect((await queue.sync()).items).toHaveLength(1)
    await rm(other, { recursive: true, force: true })
  })

  it('starts each job with its own agent, changeable until it starts', async () => {
    const agents: string[] = []
    queue = new TailorQueue(
      deps({
        start: async (params, agent) => {
          agents.push(agent)
          started.push({ params, at: Date.now() })
          return manager.start(params, ctx())
        }
      })
    )
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id))
    await queue.setPaused(true)
    const res = await queue.enqueue({ jobIds: ['url:a', 'url:b'], options, agent: 'codex' })
    // Enqueuing resumes the queue; hold it to change one row first.
    await queue.setPaused(true)
    expect(res.state.items.map((i) => i.agent)).toEqual(['codex', 'codex'])
    const b = res.state.items[1]
    await queue.setAgent(b.id, 'antigravity')
    await queue.setPaused(false)
    const s = await until(all('needs-reply'))
    expect(agents.sort()).toEqual(['antigravity', 'codex'])
    await expect(queue.setAgent(s.items[0].id, 'claude')).rejects.toThrow(/before the job starts/)
  })

  it('does not retry a used-up quota automatically, but does retry a rate limit', async () => {
    const stub = (id: string): RunSummary => ({
      id,
      title: 'x',
      params: { coverLetter: false, dateStyle: 'right' },
      agent: 'antigravity',
      status: 'running',
      sessionId: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
      outputFolder: null,
      outputFiles: [],
      costUsd: 0,
      live: true
    })
    const ids = ['20260930-010203-aaaaaa', '20260930-010203-bbbbbb']
    queue = new TailorQueue(deps({ start: async () => stub(ids.shift()!), retryDelayMs: 60_000 }))
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id))
    await queue.enqueue({ jobIds: ['url:a', 'url:b'], options })
    const s = await until((st) => st.items.every((i) => i.runId))
    const [a, b] = s.items
    queue.onRun({ ...stub(a.runId!), status: 'failed', error: "Antigravity's quota is used up: RESOURCE_EXHAUSTED (code 429)" })
    queue.onRun({ ...stub(b.runId!), status: 'failed', error: 'API Error: 429 Too Many Requests' })
    expect(queue.state().items.map((i) => [i.status, i.attempts])).toEqual([
      ['failed', 0],
      ['queued', 1]
    ])
    // A failed job keeps its old run id, and can still switch agent before it is retried.
    expect((await queue.setAgent(a.id, 'codex')).items[0].agent).toBe('codex')
  })

  it('cancelling a Codex job between turns stops its run, which has no process', async () => {
    const codexCtx = (): RunContext => ({
      ...ctx(),
      agent: 'codex',
      commandPrefixArgs: [join(__dirname, '../cli/fixtures/fake-codex.mjs')]
    })
    queue = new TailorQueue(deps({ start: async (params) => manager.start(params, codexCtx()) }))
    jobs.set('url:a', job('url:a'))
    await queue.enqueue({ jobIds: ['url:a'], options, agent: 'codex' })
    const s = await until(all('needs-reply'))
    const runId = s.items[0].runId!
    await manager.whenIdle()
    expect(manager.isLive(runId)).toBe(false)
    await queue.cancel(s.items[0].id)
    await manager.whenIdle()
    expect((await readRun(ws, runId)).status).toBe('stopped')
    expect(queue.state().items[0].status).toBe('cancelled')
  })

  it('reads items saved before agents could be chosen as Claude items', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    const at = '2026-09-30T00:00:00.000Z'
    const item = { id: 'q-20260930-010203-a1b2c3', jobId: 'url:a', title: 'x', options, status: 'queued', runId: null, attempts: 0, createdAt: at, updatedAt: at }
    await writeFile(queueFile(ws), JSON.stringify({ version: 1, concurrency: 2, items: [item] }))
    expect((await queue.sync()).items[0].agent).toBe('claude')
  })

  it('ignores a broken queue file', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    await writeFile(queueFile(ws), '{not json')
    expect((await queue.sync()).items).toEqual([])
  })
})

describe('queue input validation', () => {
  it('accepts a bulk request and normalizes it', () => {
    expect(
      requireEnqueueInput({ jobIds: ['url:a', 'url:a', 'hiring.cafe:b'], options: { coverLetter: true, dateStyle: 'inline', notes: ' x ' }, concurrency: 3 })
    ).toEqual({ jobIds: ['url:a', 'hiring.cafe:b'], options: { coverLetter: true, dateStyle: 'inline', notes: 'x' }, agent: 'claude', concurrency: 3 })
  })

  it('rejects bad ids, too many jobs, bad options, unknown agents and concurrency out of range', () => {
    const ok = { coverLetter: true, dateStyle: 'right' }
    expect(() => requireEnqueueInput({ jobIds: [], options: ok })).toThrow(/at least one/)
    expect(() => requireEnqueueInput({ jobIds: ['../etc'], options: ok })).toThrow(/Invalid job id/)
    expect(() => requireEnqueueInput({ jobIds: Array.from({ length: 101 }, (_, i) => `url:${i}`), options: ok })).toThrow(/at most 100/)
    expect(() => requireEnqueueInput({ jobIds: ['url:a'], options: { dateStyle: 'right' } })).toThrow(/cover letters/)
    expect(() => requireEnqueueInput({ jobIds: ['url:a'], options: ok, agent: 'gpt' })).toThrow(/agent/)
    expect(requireEnqueueInput({ jobIds: ['url:a'], options: ok, agent: 'codex' }).agent).toBe('codex')
    // No agent: the default agent from Settings.
    expect(requireEnqueueInput({ jobIds: ['url:a'], options: ok }, 'antigravity').agent).toBe('antigravity')
    expect(() => requireEnqueueInput({ jobIds: ['url:a'], options: ok, concurrency: 5 })).toThrow(/1 to 4/)
    expect(() => requireConcurrency(0)).toThrow()
    expect(() => requireConcurrency(1.5)).toThrow()
    expect(requireConcurrency(4)).toBe(4)
    expect(() => requireItemId('q-../x')).toThrow()
    expect(requireItemId('q-20260930-010203-a1b2c3')).toBe('q-20260930-010203-a1b2c3')
  })
})
