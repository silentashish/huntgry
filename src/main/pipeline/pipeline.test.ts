import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { PipelineBudget, PipelineState, PipelineSummary } from '@shared/pipeline-types'
import type { QueueOptions, QueueState } from '@shared/queue-types'
import type { AgentId, RunSummary, StartRunParams } from '@shared/runner-types'
import { readTracking } from '../applications/tracking'
import { RunManager, type RunContext } from '../cli/runner'
import { readEvents, readRun, saveRun } from '../cli/runs'
import { queueFile, TailorQueue, type QueueDeps } from '../queue/queue'
import { LIMIT_MARGIN_MS } from './failures'
import { NUDGE_TEXT, Pipeline, summaryFile, type PipelineDeps } from './pipeline'
import { requirePipelineStartInput } from './service'

const FAKE_CLAUDE = join(__dirname, '../cli/fixtures/fake-claude.mjs')
const FAKE_CODEX = join(__dirname, '../cli/fixtures/fake-codex.mjs')
const options: QueueOptions = { coverLetter: false, dateStyle: 'right' }

let ws: string
let jobs: Map<string, Job>
let manager: RunManager
let queue: TailorQueue
let pipeline: Pipeline
let queueStates: QueueState[]
let states: (PipelineState | null)[]
let finished: PipelineSummary[]
let awake: boolean[]
let notifications: { category: string; title: string; body: string }[]
let badges: number[]
let started: { agent: AgentId; params: StartRunParams }[]
let aborted: string[]
let offset = 0
let agentsReady: Record<AgentId, boolean>
let onBattery = false
let history: { medianMs: number | null; medianCostUsd: number | null }

const now = () => Date.now() + offset

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

function ctx(agent: AgentId = 'claude'): RunContext {
  return {
    agent,
    workspace: ws,
    skillDir: '/skills/resume-tailor',
    sandbox: { workspace: ws, skillDir: '/skills/resume-tailor', venvDir: '/venv', texRoot: null },
    command: process.execPath,
    commandPrefixArgs: [agent === 'codex' ? FAKE_CODEX : FAKE_CLAUDE],
    env: { ...process.env },
    systemPrompt: 'test'
  }
}

function queueDeps(over: Partial<QueueDeps> = {}): QueueDeps {
  return {
    workspace: async () => ws,
    findJob: async (_ws, id) => jobs.get(id) ?? null,
    fetchDetails: async (_ws, id) => {
      const j = jobs.get(id)!
      if (j.source === 'indeed') throw new Error('Indeed needs a human check.')
      const full = { ...j, description: 'Full posting text.', descriptionComplete: true }
      jobs.set(id, full)
      return full
    },
    markTailored: async () => undefined,
    start: async (params, agent) => {
      started.push({ agent, params })
      return manager.start(params, ctx(agent))
    },
    stopRun: (id, workspace) => manager.stopAny(workspace, id),
    finishRun: (id, workspace) => {
      if (manager.isLive(id)) manager.finish(id)
      else void manager.endIdle(workspace, id, 'finished')
    },
    reply: (id, text) => manager.reply(id, text, async () => ctx()),
    onChange: (s) => queueStates.push(s),
    now,
    spawnGapMs: 0,
    retryDelayMs: 20,
    ...over
  }
}

function pipelineDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    queue,
    workspace: async () => ws,
    findJob: async (_ws, id) => jobs.get(id) ?? null,
    fetchDetails: queueDeps().fetchDetails,
    tailoredJobIds: async () => new Set(['tailored-before']),
    environment: async () => ({
      agents: (['claude', 'codex', 'antigravity'] as AgentId[]).map((id) => ({
        id,
        ready: agentsReady[id],
        problems: agentsReady[id] ? [] : [`${id} is not signed in.`]
      })),
      sharedProblems: []
    }),
    freeDiskBytes: async () => 10 * 1024 * 1024 * 1024,
    runHistory: async () => history,
    verify: async () => ({ ok: false, report: 'verify.py could not be run: no venv' }),
    liveRun: (id) => manager.liveRun(id),
    abort: (id, reason) => {
      aborted.push(id)
      manager.abort(id, reason)
    },
    notify: (category, title, body) => notifications.push({ category, title, body }),
    setBadge: (n) => badges.push(n),
    keepAwake: (on) => awake.push(on),
    onBattery: () => onBattery,
    emit: (s) => states.push(s),
    emitFinished: (s) => finished.push(s),
    now,
    tickMs: 40,
    random: () => 0.5,
    burstRetryMs: 20,
    ...over
  }
}

type StartInput = Parameters<Pipeline['start']>[0]
function input(jobIds: string[], over: Partial<StartInput> = {}): StartInput {
  return {
    jobIds,
    options,
    agent: 'claude',
    concurrency: 2,
    resumeAfterRestart: true,
    skipTailored: true,
    stallMinutes: 5,
    ...over
  }
}

/** Waits until the latest pipeline state and queue state satisfy `pred`. */
async function until(pred: (p: PipelineState | null, q: QueueState) => boolean, ms = 8000): Promise<PipelineState | null> {
  const t0 = Date.now()
  for (;;) {
    const p = pipeline.state()
    const q = queue.state()
    if (pred(p, q)) return p
    if (Date.now() - t0 > ms)
      throw new Error(`timeout; pipeline ${p?.status}, items ${q.items.map((i) => `${i.status}${i.outcome ? `·${i.outcome}` : ''}`).join(',')}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const statuses = (q: QueueState) => q.items.map((i) => i.status)
const setJobs = (...ids: string[]) => ids.forEach((id) => jobs.set(id, job(id)))

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-pipeline-'))
  jobs = new Map()
  queueStates = []
  states = []
  finished = []
  awake = []
  notifications = []
  badges = []
  started = []
  aborted = []
  offset = 0
  onBattery = false
  agentsReady = { claude: true, codex: true, antigravity: true }
  history = { medianMs: null, medianCostUsd: null }
  manager = new RunManager({
    onEvent: () => undefined,
    onRun: (r: RunSummary) => {
      queue.onRun(r)
      pipeline.onRun(r)
    }
  })
  queue = new TailorQueue(queueDeps())
  pipeline = new Pipeline(pipelineDeps())
})

afterEach(async () => {
  await pipeline.shutdown()
  await queue.shutdown()
  manager.stopAll()
  await manager.whenIdle()
  await rm(ws, { recursive: true, force: true })
})

describe('Pipeline', { timeout: 30_000 }, () => {
  it('runs every job unattended within the concurrency cap and records each result as Unreviewed', async () => {
    setJobs('url:a', 'url:b', 'url:c', 'url:d', 'url:e', 'url:f')
    const state = await pipeline.start(input(['url:a', 'url:b', 'url:c', 'url:d', 'url:e', 'url:f'], { options: { ...options, notes: 'SLOW WRITE_NOTES' } }))
    expect(state.status).toBe('running')
    expect(state.counts.total).toBe(6)
    expect(state.counts.queued + state.counts.running).toBe(6)
    expect(awake[0]).toBe(true)
    let peak = 0
    const t0 = Date.now()
    while (pipeline.state()?.status !== 'finished' && Date.now() - t0 < 15000) {
      peak = Math.max(peak, queue.state().items.filter((i) => i.status === 'running' || i.status === 'preparing').length)
      await new Promise((r) => setTimeout(r, 5))
    }
    const done = await until((p) => p?.status === 'finished')
    expect(peak).toBe(2)
    expect(done!.counts).toMatchObject({ unreviewed: 6, needsAttention: 0, failed: 0, queued: 0, running: 0 })
    const items = queue.state().items
    expect(items.every((i) => i.status === 'done' && i.outcome === 'unreviewed' && i.unattended && i.applicationId)).toBe(true)
    expect(started.every((s) => s.params.unattended === true)).toBe(true)
    // No unattended run keeps a process alive.
    await manager.whenIdle()
    for (const i of items) {
      expect(manager.isLive(i.runId!)).toBe(false)
      const run = await readRun(ws, i.runId!)
      expect(run.status).toBe('finished')
      expect(run.outputFiles).toContain('review-notes.md')
      expect((await readTracking(join(ws, i.applicationId!))).review).toMatchObject({ state: 'unreviewed', runId: i.runId })
    }
    expect(awake[awake.length - 1]).toBe(false)
    expect(finished).toHaveLength(1)
    expect(finished[0].counts.unreviewed).toBe(6)
    expect(finished[0].items.every((i) => i.outcome === 'unreviewed')).toBe(true)
    expect(JSON.parse(await readFile(summaryFile(ws), 'utf8')).id).toBe(state.id)
    expect(await pipeline.lastSummary()).toMatchObject({ id: state.id })
    expect(notifications.map((n) => n.category)).toEqual(['pipeline-finished'])
    expect(badges).toEqual([6])
  })

  it('needs attention when the build report fails, when review notes are missing, and when the resume is missing after a nudge', async () => {
    jobs.set('url:fail', job('url:fail'))
    jobs.set('url:nonotes', job('url:nonotes'))
    jobs.set('url:ask', job('url:ask'))
    await pipeline.start(input(['url:fail'], { options: { ...options, notes: 'VERIFY_FAIL' }, concurrency: 1 }))
    await until((p) => p?.status === 'finished')
    const fail = queue.state().items[0]
    expect(fail).toMatchObject({ status: 'done', outcome: 'needs-attention' })
    expect(fail.error).toMatch(/Failed checks: page_count/)
    expect((await readTracking(join(ws, fail.applicationId!))).review).toMatchObject({ state: 'needs-attention', reason: expect.stringContaining('page_count') })

    await pipeline.start(input(['url:nonotes'], { options: { ...options, notes: 'NO_NOTES' }, concurrency: 1 }))
    await until((p) => p?.status === 'finished' && p.counts.needsAttention === 1)
    const nonotes = queue.state().items[1]
    expect(nonotes).toMatchObject({ status: 'done', outcome: 'needs-attention' })
    expect(nonotes.error).toMatch(/No review notes/)

    await pipeline.start(input(['url:ask'], { options: { ...options, notes: 'ASK' }, concurrency: 1 }))
    const p = await until((p) => p?.status === 'finished' && p.counts.needsReply === 1)
    const ask = queue.state().items[2]
    expect(ask).toMatchObject({ status: 'needs-reply', nudged: true })
    expect(ask.error).toMatch(/Stopped with a question/)
    expect(p!.counts).toMatchObject({ needsReply: 1, unreviewed: 0 })
    // Exactly one nudge was sent, with the unattended rule, and the session is kept for the user.
    await manager.flush(ask.runId!)
    const events = await readEvents(ws, ask.runId!)
    const nudges = events.filter((e) => (e as { subtype?: string; text?: string }).subtype === 'user_message' && (e as { text?: string }).text === NUDGE_TEXT)
    expect(nudges).toHaveLength(1)
    expect((await readRun(ws, ask.runId!)).sessionId).toBe('sess-fake-1')
    expect(finished.at(-1)!.items[0].outcome).toBe('needs-reply')
  })

  it('pauses on a usage limit until the parsed reset + 2 min, consumes no retry, holds launches, then resumes by itself', async () => {
    setJobs('url:a', 'url:b', 'url:c')
    const reset = Math.floor(now() / 1000) + 60
    // Every first turn hits the wall; a resumed job (second spawn) builds.
    jobs.set('url:a', job('url:a', { description: `USAGE_LIMIT:${reset}` }))
    jobs.set('url:b', job('url:b', { description: `USAGE_LIMIT:${reset}` }))
    jobs.set('url:c', job('url:c', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b', 'url:c'], { concurrency: 2 }))
    const waiting = await until((p) => p?.status === 'waiting-limit')
    expect(waiting!.until).toBe(new Date(reset * 1000 + LIMIT_MARGIN_MS).toISOString())
    expect(waiting!.limitAgent).toBe('claude')
    const q = queue.state()
    expect(statuses(q)).toEqual(['queued', 'queued', 'queued'])
    expect(q.items.slice(0, 2).every((i) => i.retries === 0 && i.attempts === 1 && i.lastFailure === 'usage-limit' && i.notBefore === waiting!.until)).toBe(true)
    expect(q.items[0].error).toMatch(/Waiting for Claude's limit/)
    expect(notifications.map((n) => n.category)).toEqual(['usage-limit'])
    expect(notifications[0].title).toMatch(/paused until/)
    // Nothing starts while the limit holds, not even the job that would build.
    queue.kick()
    await new Promise((r) => setTimeout(r, 150))
    expect(started).toHaveLength(2)
    expect(awake.at(-1)).toBe(true)
    // The clock passes the reset: the pipeline wakes, everything runs and finishes.
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id, { description: 'WRITE_NOTES' }))
    offset += 60_000 + LIMIT_MARGIN_MS + 1000
    pipeline.wake()
    const done = await until((p) => p?.status === 'finished')
    expect(done!.counts).toMatchObject({ unreviewed: 3, failed: 0 })
    expect(queue.state().items.every((i) => i.retries === 0)).toBe(true)
  })

  it('switches the remaining jobs to the fallback agent on a usage limit instead of waiting', async () => {
    jobs.set('url:a', job('url:a', { description: `USAGE_LIMIT:${Math.floor(now() / 1000) + 3600}` }))
    jobs.set('url:b', job('url:b', { description: 'WRITE_OUTPUT' }))
    jobs.set('url:c', job('url:c', { description: 'WRITE_OUTPUT' }))
    // Only Claude hits the wall: the fake Codex gets a description that builds.
    queue = new TailorQueue(
      queueDeps({
        start: async (params, agent) => {
          started.push({ agent, params })
          return manager.start(agent === 'codex' ? { ...params, jobDescription: 'WRITE_OUTPUT' } : params, ctx(agent))
        }
      })
    )
    pipeline = new Pipeline(pipelineDeps())
    await pipeline.start(input(['url:a', 'url:b', 'url:c'], { concurrency: 1, fallbackAgent: 'codex' }))
    const done = await until((p) => p?.status === 'finished')
    expect(states.every((s) => s?.status !== 'waiting-limit')).toBe(true)
    expect(started.map((s) => s.agent)).toEqual(['claude', 'codex', 'codex', 'codex'])
    expect(queue.state().items.map((i) => [i.agent, i.status, i.retries])).toEqual([
      ['codex', 'done', 0],
      ['codex', 'done', 0],
      ['codex', 'done', 0]
    ])
    // The fake Codex writes no review notes, so the results need attention; that is the verify gate, not the limit.
    expect(done!.counts).toMatchObject({ needsAttention: 3, failed: 0 })
    expect(states.some((s) => s?.fallbackActive)).toBe(true)
    // The limit message is gone once the job ran on Codex; the error now is the verify gate's reason.
    expect(queue.state().items[0].error).toMatch(/No review notes/)
    expect(queue.state().items[0].lastFailure).toBe('usage-limit')
  })

  it('retries a crash at +30 s and +120 s, then fails with the last error', async () => {
    jobs.set('url:a', job('url:a', { description: 'CRASH' }))
    await pipeline.start(input(['url:a'], { concurrency: 1 }))
    const first = await until((_p, q) => q.items[0]?.status === 'queued' && q.items[0].retries === 1)
    expect(first!.status).toBe('running')
    const item = () => queue.state().items[0]
    expect(item().lastFailure).toBe('transient')
    expect(item().error).toMatch(/retrying in 30 s \(1 of 2\)/)
    expect(Date.parse(item().notBefore!) - now()).toBeGreaterThan(29_000)
    offset += 31_000
    pipeline.wake()
    await until((_p, q) => q.items[0]?.status === 'queued' && q.items[0].retries === 2)
    expect(item().error).toMatch(/retrying in 120 s \(2 of 2\)/)
    offset += 121_000
    pipeline.wake()
    const done = await until((p) => p?.status === 'finished')
    expect(item().status).toBe('failed')
    expect(item().error).toMatch(/Failed 3 times; last error: .*boom: simulated failure/)
    expect(started).toHaveLength(3)
    expect(done!.counts.failed).toBe(1)
    expect(finished[0].items[0]).toMatchObject({ outcome: 'failed', error: expect.stringContaining('boom') })
  })

  it('kills a run with no output for the stall threshold and retries it', async () => {
    jobs.set('url:a', job('url:a', { description: 'STALL' }))
    await pipeline.start(input(['url:a'], { concurrency: 1, stallMinutes: 5 }))
    await until((_p, q) => q.items[0]?.status === 'running' && !!q.items[0].runId)
    const runId = queue.state().items[0].runId!
    await new Promise((r) => setTimeout(r, 100))
    expect(aborted).toEqual([])
    offset += 6 * 60_000
    await until((_p, q) => q.items[0]?.status === 'queued' && q.items[0].retries === 1)
    expect(aborted).toEqual([runId])
    const item = queue.state().items[0]
    expect(item.lastFailure).toBe('stall')
    expect(item.error).toMatch(/No output from the agent; retrying/)
    expect((await readRun(ws, runId)).error).toBe('No output for 5 minutes.')
  })

  it('stops starting jobs once the job cap is reached and continues after the budget is raised', async () => {
    setJobs('url:a', 'url:b', 'url:c', 'url:d')
    for (const id of ['url:a', 'url:b', 'url:c', 'url:d']) jobs.set(id, job(id, { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b', 'url:c', 'url:d'], { concurrency: 1, budget: { maxJobs: 2 } }))
    const stopped = await until((p) => p?.status === 'stopped-budget')
    expect(stopped!.startedJobs).toBe(2)
    expect(stopped!.stopReason).toMatch(/2 of 2 jobs started/)
    expect(statuses(queue.state())).toEqual(['done', 'done', 'queued', 'queued'])
    expect(notifications.map((n) => n.category)).toEqual(['budget'])
    expect(awake.at(-1)).toBe(false)
    await pipeline.resume({ budget: { maxJobs: 4 } })
    const done = await until((p) => p?.status === 'finished')
    expect(done!.counts.unreviewed).toBe(4)
  })

  it('stops on the Claude cost cap (the fake charges $0.01 per turn)', async () => {
    for (const id of ['url:a', 'url:b', 'url:c']) jobs.set(id, job(id, { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b', 'url:c'], { concurrency: 1, budget: { maxCostUsd: 0.02 } as PipelineBudget }))
    const stopped = await until((p) => p?.status === 'stopped-budget')
    expect(stopped!.costUsd).toBeCloseTo(0.02)
    expect(stopped!.stopReason).toMatch(/\$0\.02 of \$0\.02/)
    expect(statuses(queue.state())).toEqual(['done', 'done', 'queued'])
  })

  it('pause holds new jobs (running ones finish their turn), resume continues, stop cancels the rest', async () => {
    for (const id of ['url:a', 'url:b', 'url:c', 'url:d']) jobs.set(id, job(id, { description: 'SLOW WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b', 'url:c', 'url:d'], { concurrency: 1 }))
    await until((_p, q) => q.items[0]?.status === 'running')
    const paused = await pipeline.pause()
    expect(paused.status).toBe('paused')
    await until((_p, q) => q.items[0]?.status === 'done')
    await new Promise((r) => setTimeout(r, 100))
    expect(statuses(queue.state())).toEqual(['done', 'queued', 'queued', 'queued'])
    expect(awake.at(-1)).toBe(false)
    await pipeline.resume()
    await until((_p, q) => q.items[1]?.status === 'running')
    expect(awake.at(-1)).toBe(true)
    const stopping = await pipeline.stop()
    expect(['stopping', 'finished']).toContain(stopping.status)
    const done = await until((p) => p?.status === 'finished')
    await manager.whenIdle()
    expect(statuses(queue.state())).toEqual(['done', 'cancelled', 'cancelled', 'cancelled'])
    expect(done!.stopReason).toBe('Stopped by you.')
    expect(done!.counts).toMatchObject({ unreviewed: 1, cancelled: 3 })
    expect(finished[0].items.map((i) => i.outcome)).toEqual(['unreviewed', 'cancelled', 'cancelled', 'cancelled'])
    expect(manager.isLive(queue.state().items[1].runId!)).toBe(false)
  })

  it('shares the concurrency with attended queue items', async () => {
    setJobs('url:attended', 'url:a', 'url:b')
    await queue.enqueue({ jobIds: ['url:attended'], options: { ...options, notes: 'SLOW' }, concurrency: 1 })
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id, { description: 'SLOW WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b'], { concurrency: 1 }))
    let peak = 0
    const t0 = Date.now()
    while (pipeline.state()?.status !== 'finished' && Date.now() - t0 < 8000) {
      peak = Math.max(peak, queue.state().items.filter((i) => i.status === 'running' || i.status === 'preparing').length)
      await new Promise((r) => setTimeout(r, 5))
    }
    const done = await until((p) => p?.status === 'finished')
    expect(peak).toBe(1)
    expect(statuses(queue.state())).toEqual(['needs-reply', 'done', 'done'])
    // The pipeline counts only its own items.
    expect(done!.counts.total).toBe(2)
  })

  it('requeues interrupted items once after a restart and resumes without Resume; a second interruption fails them', async () => {
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id, { description: 'SLOW WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b'], { concurrency: 2 }))
    await until((_p, q) => q.items.every((i) => i.status === 'running'))
    // As on quit: the pipeline releases keep-awake, the queue stops following, the processes die.
    await pipeline.shutdown()
    await queue.shutdown()
    manager.stopAll()
    await manager.whenIdle()
    expect(awake.at(-1)).toBe(false)
    const saved = JSON.parse(await readFile(queueFile(ws), 'utf8'))
    expect(saved.pipeline).toMatchObject({ status: 'running', itemIds: expect.any(Array) })
    expect(saved.items.every((i: { status: string }) => i.status === 'running')).toBe(true)

    // Relaunch.
    queue = new TailorQueue(queueDeps())
    pipeline = new Pipeline(pipelineDeps())
    manager = new RunManager({ onEvent: () => undefined, onRun: (r) => (queue.onRun(r), pipeline.onRun(r)) })
    await pipeline.init(0)
    const state = pipeline.state()!
    expect(state.status).toBe('running')
    expect(state.interrupted).toBe(true)
    expect(state.warnings.some((w) => /interrupted jobs were queued again/.test(w))).toBe(true)
    expect(queue.state().paused).toBe(false)
    const done = await until((p) => p?.status === 'finished')
    expect(done!.counts.unreviewed).toBe(2)
    expect(queue.state().items.every((i) => i.interruptedOnce && i.status === 'done')).toBe(true)

    // A second interruption of the same items fails them.
    const raw = JSON.parse(await readFile(queueFile(ws), 'utf8'))
    raw.items = raw.items.map((i: Record<string, unknown>) => ({ ...i, status: 'running', outcome: undefined }))
    raw.pipeline.status = 'running'
    await writeFile(queueFile(ws), JSON.stringify(raw))
    await pipeline.shutdown()
    await queue.shutdown()
    queue = new TailorQueue(queueDeps())
    pipeline = new Pipeline(pipelineDeps())
    await pipeline.init(0)
    expect(statuses(queue.state())).toEqual(['failed', 'failed'])
    expect(queue.state().items[0].error).toMatch(/closed while/)
    expect(pipeline.state()!.status).toBe('finished')
    expect(pipeline.state()!.counts.failed).toBe(2)
  })

  it('reloads paused with a notice when resume-after-restart is off', async () => {
    jobs.set('url:a', job('url:a', { description: 'SLOW WRITE_NOTES' }))
    await pipeline.start(input(['url:a'], { concurrency: 1, resumeAfterRestart: false }))
    await until((_p, q) => q.items[0]?.status === 'running')
    await pipeline.shutdown()
    await queue.shutdown()
    manager.stopAll()
    await manager.whenIdle()
    queue = new TailorQueue(queueDeps())
    pipeline = new Pipeline(pipelineDeps())
    manager = new RunManager({ onEvent: () => undefined, onRun: (r) => (queue.onRun(r), pipeline.onRun(r)) })
    await pipeline.init(0)
    expect(queue.state().paused).toBe(true)
    const state = pipeline.state()!
    expect(state.status).toBe('paused')
    expect(state.warnings).toContain('Pipeline interrupted by a restart. Press Resume to continue.')
    expect(statuses(queue.state())).toEqual(['queued'])
    await new Promise((r) => setTimeout(r, 100))
    expect(started).toHaveLength(1)
    await pipeline.resume()
    const done = await until((p) => p?.status === 'finished')
    expect(done!.counts.unreviewed).toBe(1)
    expect(started).toHaveLength(2)
  })

  it('pauses with the reason when the agent cannot be started, and a done result can be re-run through the queue', async () => {
    let signedIn = false
    queue = new TailorQueue(
      queueDeps({
        start: async (params, agent) => {
          if (!signedIn) throw new Error('Claude Code is not signed in. Run claude auth login in a terminal.')
          started.push({ agent, params })
          return manager.start(params, ctx(agent))
        }
      })
    )
    pipeline = new Pipeline(pipelineDeps())
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id, { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b'], { concurrency: 1 }))
    const paused = await until((p) => p?.status === 'paused')
    expect(paused!.stopReason).toMatch(/Cannot start Claude: Claude Code is not signed in/)
    expect(statuses(queue.state())).toEqual(['failed', 'queued'])
    expect(notifications.map((n) => n.category)).toEqual(['failed'])
    signedIn = true
    await queue.retry(queue.state().items[0].id)
    await pipeline.resume()
    const done = await until((p) => p?.status === 'finished')
    expect(done!.counts.unreviewed).toBe(2)

    // Re-run with my answers: the done item goes back to running on its own session and settles again.
    const item = queue.state().items[0]
    const sent = await queue.reply(item.runId!, 'The user reviewed the notes. SECOND:VERIFY_FAIL WRITE_OUTPUT_AT:software-engineer/acme/a')
    expect(sent).not.toBeNull()
    await until((_p, q) => q.items[0].status === 'done' && q.items[0].outcome === 'needs-attention')
    expect(queue.state().items[0].runId).toBe(item.runId)
    expect((await readRun(ws, item.runId!)).sessionId).toBe('sess-fake-1')
  })

  it('plans: skips unsaved, dismissed, queued, tailored-before and unreadable jobs, blocks on an agent, estimates from history', async () => {
    jobs.set('url:ok', job('url:ok'))
    jobs.set('url:gone', job('url:gone', { dismissed: true }))
    jobs.set('url:tailored-before', job('url:tailored-before'))
    jobs.set('indeed:x', job('indeed:x', { descriptionComplete: false }))
    jobs.set('hiring.cafe:y', job('hiring.cafe:y', { descriptionComplete: false }))
    jobs.set('url:queued', job('url:queued'))
    await queue.enqueue({ jobIds: ['url:queued'], options })
    await queue.setPaused(true)
    history = { medianMs: 10 * 60_000, medianCostUsd: 0.8 }
    onBattery = true
    const plan = await pipeline.plan(input(['url:ok', 'url:nope', 'url:gone', 'url:tailored-before', 'indeed:x', 'hiring.cafe:y', 'url:queued'], { concurrency: 2, fallbackAgent: 'codex' }))
    expect(plan.ready.map((j) => j.jobId)).toEqual(['url:ok', 'hiring.cafe:y'])
    expect(plan.skipped.map((s) => [s.jobId, s.reason])).toEqual([
      ['url:nope', 'This job is no longer saved.'],
      ['url:gone', 'Dismissed jobs are not tailored.'],
      ['url:tailored-before', 'Tailored before (untick "Skip jobs tailored before" to include it).'],
      ['indeed:x', expect.stringMatching(/human check.*Paste a job/)],
      ['url:queued', 'Already in the queue.']
    ])
    expect(plan.blockers).toEqual([])
    expect(plan.estimateMinutes).toBe(10)
    expect(plan.estimateCostUsd).toBe(1.6)
    expect(plan.onBattery).toBe(true)
    expect(plan.warnings.some((w) => /On battery/.test(w))).toBe(true)
    // Not skipping tailored-before jobs includes them.
    expect((await pipeline.plan(input(['url:tailored-before'], { skipTailored: false }))).ready).toHaveLength(1)
    // Blockers: the agent, the fallback, the disk.
    agentsReady.codex = false
    const blocked = await pipeline.plan(input(['url:ok'], { fallbackAgent: 'codex' }))
    expect(blocked.blockers).toEqual(['Fallback Codex: codex is not signed in.'])
    await expect(pipeline.start(input(['url:ok'], { fallbackAgent: 'codex' }))).rejects.toThrow(/Fallback Codex/)
    expect(queue.state().items).toHaveLength(1)
    await expect(pipeline.start(input(['url:nope']))).rejects.toThrow(/No job can run unattended/)
    pipeline = new Pipeline(pipelineDeps({ freeDiskBytes: async () => 100 * 1024 * 1024 }))
    expect((await pipeline.plan(input(['url:ok']))).blockers[0]).toMatch(/Only 100 MB are free/)
  })

  it('records the summary and hides the utilisation until Claude warns; dismiss clears a finished pipeline', async () => {
    jobs.set('url:a', job('url:a', { description: 'RATE_WARN WRITE_NOTES' }))
    await pipeline.start(input(['url:a'], { concurrency: 1 }))
    const done = await until((p) => p?.status === 'finished')
    expect(done!.utilization).toBe(0.96)
    expect(done!.costUsd).toBeCloseTo(0.01)
    await pipeline.dismiss()
    await queue.flush()
    expect(pipeline.state()).toBeNull()
    expect(states.at(-1)).toBeNull()
    expect(JSON.parse(await readFile(queueFile(ws), 'utf8')).pipeline).toBeNull()
    await expect(pipeline.pause()).rejects.toThrow(/No pipeline/)
  })

  it('settles an unattended run that failed after building, and reads old queue files without pipeline fields', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    const at = '2026-09-30T00:00:00.000Z'
    await writeFile(queueFile(ws), JSON.stringify({ version: 1, concurrency: 2, items: [{ id: 'q-20260930-010203-a1b2c3', jobId: 'url:a', title: 'x', options, status: 'queued', runId: null, attempts: 0, createdAt: at, updatedAt: at }] }))
    await pipeline.init(0)
    expect(pipeline.state()).toBeNull()
    expect(queue.state().items[0].unattended).toBeUndefined()
    // A run that crashed after building: the verify gate, not a retry.
    jobs.set('url:b', job('url:b', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:b'], { concurrency: 1 }))
    await until((p) => p?.status === 'finished')
    const item = queue.state().items[1]
    const run = await readRun(ws, item.runId!)
    await saveRun(ws, { ...run, status: 'failed', error: 'boom' })
    queue.onRun({ ...run, status: 'failed', error: 'boom', live: false })
    expect(queue.state().items[1].status).toBe('done')
  })

  it('validates the start input', () => {
    const ok = { jobIds: ['url:a'], options: { coverLetter: true, dateStyle: 'right' } }
    expect(requirePipelineStartInput(ok)).toMatchObject({ agent: 'claude', concurrency: 2, resumeAfterRestart: true, skipTailored: true, stallMinutes: 20 })
    expect(requirePipelineStartInput({ ...ok, agent: 'codex', fallbackAgent: 'claude', budget: { maxCostUsd: 40, maxJobs: 10 }, resumeAfterRestart: false, skipTailored: false, stallMinutes: 5, concurrency: 4 })).toMatchObject({ agent: 'codex', fallbackAgent: 'claude', budget: { maxCostUsd: 40, maxJobs: 10 }, resumeAfterRestart: false, skipTailored: false, stallMinutes: 5, concurrency: 4 })
    expect(() => requirePipelineStartInput({ ...ok, fallbackAgent: 'claude' })).toThrow(/differ/)
    expect(() => requirePipelineStartInput({ ...ok, fallbackAgent: 'gpt' })).toThrow(/fallback agent/)
    expect(() => requirePipelineStartInput({ ...ok, budget: { maxCostUsd: 0.5 } })).toThrow(/cost cap/)
    expect(() => requirePipelineStartInput({ ...ok, budget: { maxJobs: 101 } })).toThrow(/job cap/)
    expect(() => requirePipelineStartInput({ ...ok, stallMinutes: 3 })).toThrow(/stall/)
    expect(() => requirePipelineStartInput({ ...ok, resumeAfterRestart: 'yes' })).toThrow(/resumeAfterRestart/)
    expect(requirePipelineStartInput({ ...ok, budget: {} }).budget).toBeUndefined()
    expect(() => requirePipelineStartInput({ ...ok, jobIds: Array.from({ length: 101 }, (_, i) => `url:${i}`) })).toThrow(/at most 100/)
  })
})
