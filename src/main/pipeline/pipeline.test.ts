import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { PipelineBudget, PipelineState, PipelineSummary } from '@shared/pipeline-types'
import type { QueueOptions, QueueState } from '@shared/queue-types'
import { reviewBlocker } from '@shared/review-types'
import type { AgentId, RunSummary, StartRunParams } from '@shared/runner-types'
import { readApplication } from '../applications/scan'
import { RunManager, type RunContext } from '../cli/runner'
import { readEvents, readRun } from '../cli/runs'
import { queueFile, TailorQueue, type QueueDeps } from '../queue/queue'
import { LIMIT_MARGIN_MS } from './failures'
import { IN_PROGRESS_REASON, NUDGE_TEXT, Pipeline, summaryFile, type PipelineDeps } from './pipeline'
import { getReview, reopenForContinuation, setReviewAuthorityRoot, updateReview } from '../review/authority'
import { approvalDrift, approveReview, discardReview, rerunReview, reviewDetail } from '../review/service'
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
    releaseRun: (id) => manager.release(id),
    readRun: (id, workspace) => readRun(workspace, id).catch(() => null),
    liveRunIds: () => manager.liveIds(),
    releaseIdle: () => manager.releaseIdle(),
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
  setReviewAuthorityRoot(`${ws}-authority`)
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
    },
    // As the app wires it (cli/start.ts): every continuation of an unattended result revokes its approval first.
    beforeReply: async (r, workspace) => {
      if ((r.unattended || r.params.unattended) && r.outputFolder) await reopenForContinuation(workspace, r.outputFolder, r.id, new Date(now()))
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
  await rm(`${ws}-authority`, { recursive: true, force: true })
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
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
      expect((await getReview(ws, i.applicationId!))).toMatchObject({ state: 'unreviewed', runId: i.runId })
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
    await until((p) => p?.status === 'finished' && finished.length > 0)
    const fail = queue.state().items[0]
    expect(fail).toMatchObject({ status: 'done', outcome: 'needs-attention' })
    expect(fail.error).toMatch(/Failed checks: page_count/)
    expect((await getReview(ws, fail.applicationId!))).toMatchObject({ state: 'needs-attention', reason: expect.stringContaining('page_count') })

    await pipeline.start(input(['url:nonotes'], { options: { ...options, notes: 'NO_NOTES' }, concurrency: 1 }))
    await until((p) => p?.status === 'finished' && p.counts.needsAttention === 1 && finished.length === 2)
    const nonotes = queue.state().items[1]
    expect(nonotes).toMatchObject({ status: 'done', outcome: 'needs-attention' })
    expect(nonotes.error).toMatch(/No review notes/)

    await pipeline.start(input(['url:ask'], { options: { ...options, notes: 'ASK' }, concurrency: 1 }))
    const p = await until((p) => p?.status === 'finished' && p.counts.needsReply === 1 && finished.length === 3)
    const ask = queue.state().items[2]
    expect(ask).toMatchObject({ status: 'needs-reply', nudged: true })
    expect(ask.error).toMatch(/Stopped with a question/)
    // No idle agent process waits for the user: the run is released, still waiting and resumable.
    await until(() => !manager.isLive(ask.runId!))
    await manager.flush(ask.runId!)
    expect((await readRun(ws, ask.runId!)).status).toBe('waiting')
    expect(p!.counts).toMatchObject({ needsReply: 1, unreviewed: 0 })
    // Exactly one nudge was sent, with the unattended rule, and the session is kept for the user.
    await manager.flush(ask.runId!)
    const events = await readEvents(ws, ask.runId!)
    const nudges = events.filter((e) => (e as { subtype?: string; text?: string }).subtype === 'user_message' && (e as { text?: string }).text === NUDGE_TEXT)
    expect(nudges).toHaveLength(1)
    expect((await readRun(ws, ask.runId!)).sessionId).toBe('sess-fake-1')
    expect(finished.at(-1)!.items[0].outcome).toBe('needs-reply')
    // ASK writes nothing, so there is no folder to mark; a run that built still gets the verify gate.
    expect(ask.applicationId).toBeUndefined()
  })

  it('marks an unattended run\'s folder Unreviewed as soon as the run records it, before the verify gate', async () => {
    await queue.sync()
    const folder = 'software-engineer/acme/job-7'
    await mkdir(join(ws, folder), { recursive: true })
    await writeFile(join(ws, folder, 'resume.pdf'), '%PDF-1.4 fake')
    const run: RunSummary = {
      id: '20261005-100000-aaaaaa',
      title: 'x',
      params: { jobDescription: 'x', coverLetter: false, dateStyle: 'right', unattended: true, jobId: 'job-7' },
      agent: 'claude',
      status: 'running',
      sessionId: 's',
      createdAt: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-10-05T10:00:00.000Z',
      outputFolder: folder,
      outputFiles: ['resume.pdf'],
      costUsd: 0,
      live: true,
      unattended: true
    }
    pipeline.onRun(run)
    const read = () => getReview(ws, folder)
    for (let i = 0; i < 100 && !(await read()); i++) await new Promise((r) => setTimeout(r, 10))
    expect(await read()).toMatchObject({ state: 'unreviewed', runId: run.id, reason: IN_PROGRESS_REASON })
    // Another job's folder (a different job id) and an attended run are never marked.
    const other = 'software-engineer/acme/job-8'
    await mkdir(join(ws, other), { recursive: true })
    pipeline.onRun({ ...run, id: '20261005-100000-bbbbbb', outputFolder: other })
    pipeline.onRun({ ...run, id: '20261005-100000-cccccc', params: { ...run.params, jobId: 'job-8' }, outputFolder: other, unattended: undefined })
    await new Promise((r) => setTimeout(r, 50))
    expect((await getReview(ws, other))).toBeUndefined()
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(done!.counts).toMatchObject({ unreviewed: 3, failed: 0 })
    expect(queue.state().items.every((i) => i.retries === 0)).toBe(true)
  })

  it('switches only the jobs that have not started to the fallback agent; started ones keep their agent and wait', async () => {
    // A short wait: the fake clock jump stays under the stall threshold of the relaunched runs.
    const reset = Math.floor(now() / 1000) + 60
    jobs.set('url:b', job('url:b', { description: 'CRASH' }))
    jobs.set('url:a', job('url:a', { description: `USAGE_LIMIT:${reset}` }))
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
    await pipeline.start(input(['url:b', 'url:a', 'url:c'], { concurrency: 1, fallbackAgent: 'codex' }))
    // b crashed and waits for its backoff retry (started, queued); a hit the limit; c never started.
    await until((_p, q) => q.items[2]?.status === 'done')
    expect(started.map((s) => s.agent)).toEqual(['claude', 'claude', 'codex'])
    const [b, a] = queue.state().items
    // Started jobs keep Claude (their session, their partial work): a waits for the reset, b for its retry.
    expect(b).toMatchObject({ agent: 'claude', status: 'queued', retries: 1, lastFailure: 'transient' })
    expect(a).toMatchObject({ agent: 'claude', status: 'queued', retries: 0, lastFailure: 'usage-limit' })
    expect(a.notBefore).toBe(new Date(reset * 1000 + LIMIT_MARGIN_MS).toISOString())
    expect(a.error).toMatch(/1 other job moved to Codex/)
    expect(states.some((s) => s?.fallbackActive)).toBe(true)
    // No "paused" notification: the pipeline went on with the fallback.
    expect(notifications.filter((n) => n.category === 'usage-limit')).toEqual([])
    // After the reset, a and b run again on Claude and the pipeline finishes.
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id, { description: 'WRITE_NOTES' }))
    offset += 60_000 + LIMIT_MARGIN_MS + 1000
    pipeline.wake()
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(started.map((s) => s.agent)).toEqual(['claude', 'claude', 'codex', 'claude', 'claude'])
    expect(queue.state().items.map((i) => [i.agent, i.status])).toEqual([
      ['claude', 'done'],
      ['claude', 'done'],
      ['codex', 'done']
    ])
    // The fake Codex writes no review notes, so its result needs attention; that is the verify gate, not the limit.
    expect(done!.counts).toMatchObject({ unreviewed: 2, needsAttention: 1, failed: 0 })
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(done!.counts.unreviewed).toBe(4)
  })

  it('the job cap does not hold the retry of a job that already started', async () => {
    jobs.set('url:a', job('url:a', { description: 'CRASH' }))
    jobs.set('url:b', job('url:b', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b'], { concurrency: 1, budget: { maxJobs: 1 } }))
    await until((_p, q) => q.items[0]?.status === 'queued' && q.items[0].retries === 1)
    offset += 31_000
    pipeline.wake()
    await until((_p, q) => q.items[0]?.status === 'queued' && q.items[0].retries === 2)
    offset += 121_000
    pipeline.wake()
    const stopped = await until((p, q) => p?.status === 'stopped-budget' && q.items[0]?.status === 'failed')
    // Job a ran three times (two retries), job b never started.
    expect(started.map((s) => s.params.jobId)).toEqual([started[0].params.jobId, started[0].params.jobId, started[0].params.jobId])
    expect(statuses(queue.state())).toEqual(['failed', 'queued'])
    expect(stopped!.startedJobs).toBe(1)
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
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
    // Answering a run whose own process is alive takes no new slot: sent at once, not held.
    await until((_p, q) => q.items[0]?.status === 'needs-reply')
    const attendedRun = queue.state().items[0].runId!
    expect(manager.isLive(attendedRun)).toBe(true)
    expect(await queue.reply(attendedRun, 'Not yet.')).not.toBe('held')
    await until((_p, q) => q.items[0].status === 'needs-reply')
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id, { description: 'SLOW WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b'], { concurrency: 1 }))
    let peak = 0
    let peakLive = 0
    const t0 = Date.now()
    while (pipeline.state()?.status !== 'finished' && Date.now() - t0 < 8000) {
      peak = Math.max(peak, queue.state().items.filter((i) => i.status === 'running' || i.status === 'preparing').length)
      // Real agent processes, waiting ones included: the attended run waiting at step 3 holds one.
      peakLive = Math.max(peakLive, manager.liveIds().length)
      await new Promise((r) => setTimeout(r, 5))
    }
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(peak).toBe(1)
    expect(peakLive).toBe(1)
    expect(statuses(queue.state())).toEqual(['needs-reply', 'done', 'done'])
    // The attended run's idle process was released for the pipeline's jobs; it still waits, resumable.
    const attended = queue.state().items[0]
    expect(manager.isLive(attended.runId!)).toBe(false)
    expect((await readRun(ws, attended.runId!)).status).toBe('waiting')
    await queue.reply(attended.runId!, 'Approved')
    await until((_p, q) => q.items[0].status === 'needs-reply' && manager.isLive(attended.runId!))
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(done!.counts.unreviewed).toBe(2)
    expect(queue.state().items.every((i) => i.interruptedOnce && i.status === 'done')).toBe(true)

    // A second interruption of the same items fails them. Shut down first: the queue's last save
    // (still in flight after `finished`) would otherwise land on top of the edited file.
    await pipeline.shutdown()
    await queue.shutdown()
    const raw = JSON.parse(await readFile(queueFile(ws), 'utf8'))
    raw.items = raw.items.map((i: Record<string, unknown>) => ({ ...i, status: 'running', outcome: undefined }))
    raw.pipeline.status = 'running'
    await writeFile(queueFile(ws), JSON.stringify(raw))
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
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
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(done!.utilization).toBe(0.96)
    expect(done!.costUsd).toBeCloseTo(0.01)
    await pipeline.dismiss()
    await queue.flush()
    expect(pipeline.state()).toBeNull()
    expect(states.at(-1)).toBeNull()
    expect(JSON.parse(await readFile(queueFile(ws), 'utf8')).pipeline).toBeNull()
    await expect(pipeline.pause()).rejects.toThrow(/No pipeline/)
  })

  it('reads old queue files without pipeline fields', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    const at = '2026-09-30T00:00:00.000Z'
    await writeFile(queueFile(ws), JSON.stringify({ version: 1, concurrency: 2, items: [{ id: 'q-20260930-010203-a1b2c3', jobId: 'url:a', title: 'x', options, status: 'queued', runId: null, attempts: 0, createdAt: at, updatedAt: at }] }))
    await pipeline.init(0)
    expect(pipeline.state()).toBeNull()
    expect(queue.state().items[0].unattended).toBeUndefined()
  })

  it('drops a pipeline saved without jobs (a start cut short by a workspace switch) instead of blocking every later start', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    const at = '2026-10-09T00:00:00.000Z'
    const stranded = { id: 'p-20261009-000000-a1b2c3', status: 'running', options: {}, itemIds: [], skipped: [], limits: {}, unparsedStrikes: 0, startedAt: at, runCosts: {} }
    await writeFile(queueFile(ws), JSON.stringify({ version: 1, concurrency: 2, items: [], pipeline: stranded }))
    await pipeline.init(0)
    expect(pipeline.state()).toBeNull()
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    expect((await pipeline.plan(input(['url:a']))).blockers).toEqual([])
    await pipeline.start(input(['url:a']))
    await until((p) => p?.status === 'finished' && finished.length > 0)
  })

  it('a run that built and then failed while still running goes to the verify gate, not a retry', async () => {
    jobs.set('url:b', job('url:b', { description: 'BUILT_THEN_ERROR' }))
    await pipeline.start(input(['url:b'], { concurrency: 1 }))
    const done = await until((p) => p?.status === 'finished' && finished.length > 0)
    const item = queue.state().items[0]
    // Recorded with the failed check of its build report; built once, never retried.
    expect(item).toMatchObject({ status: 'done', outcome: 'needs-attention', retries: 0 })
    expect(item.error).toMatch(/Failed checks: page_count/)
    expect(started).toHaveLength(1)
    expect(done!.counts).toMatchObject({ needsAttention: 1, failed: 0 })
    expect(await getReview(ws, item.applicationId!)).toMatchObject({ state: 'needs-attention', runId: item.runId })
  })

  it('refuses a second start while the first is still starting: one pipeline, one id', async () => {
    for (const id of ['url:a', 'url:b']) jobs.set(id, job(id, { description: 'WRITE_NOTES' }))
    const results = await Promise.allSettled([pipeline.start(input(['url:a'])), pipeline.start(input(['url:b']))])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message).toMatch(/already starting/)
    expect(queue.state().items).toHaveLength(1)
    expect(queue.state().items[0].pipelineId).toBe(pipeline.state()!.id)
    await until((p) => p?.status === 'finished' && finished.length > 0)
  })

  it('a finished pipeline is supervised again when its jobs get work: Retry is not stranded, a re-run is under the watchdog', async () => {
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    jobs.set('url:b', job('url:b', { description: 'CRASH' }))
    await pipeline.start(input(['url:a', 'url:b'], { concurrency: 1, stallMinutes: 5 }))
    await until((_p, q) => q.items[1]?.retries === 1)
    offset += 31_000
    pipeline.wake()
    await until((_p, q) => q.items[1]?.retries === 2)
    offset += 121_000
    pipeline.wake()
    await until((p) => p?.status === 'finished' && finished.length === 1)
    expect(statuses(queue.state())).toEqual(['done', 'failed'])
    expect(awake.at(-1)).toBe(false)

    // Retry after the pipeline finished: it runs (it was held forever before) and the pipeline finishes again.
    jobs.set('url:b', job('url:b', { description: 'WRITE_NOTES' }))
    await queue.retry(queue.state().items[1].id)
    await until((p) => p?.status === 'finished' && finished.length === 2)
    expect(statuses(queue.state())).toEqual(['done', 'done'])

    // A re-run of a done result that hangs: the pipeline is running again, the Mac kept awake, the watchdog kills it.
    const a = queue.state().items[0]
    await queue.reply(a.runId!, 'Use the gap. SECOND:STALL')
    const reopened = await until((p, q) => p?.status === 'running' && q.items[0].status === 'running')
    expect(reopened!.keepAwake).toBe(true)
    expect(aborted).toEqual([])
    offset += 6 * 60_000
    await until(() => aborted.includes(a.runId!))
    // It had built before: the verify gate records what is on disk, as needing a look, with the stall.
    await until((p, q) => q.items[0].status === 'done' && p?.status === 'finished')
    expect(queue.state().items[0]).toMatchObject({ outcome: 'needs-attention', error: expect.stringMatching(/No output for 5 minutes/) })
    expect(await getReview(ws, a.applicationId!)).toMatchObject({ state: 'needs-attention' })
  })

  it('a re-run of a done result obeys the cost cap: held without a process until the budget is raised', async () => {
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a'], { concurrency: 1, budget: { maxCostUsd: 0.01 } as PipelineBudget }))
    await until((p) => p?.status === 'finished' && finished.length > 0)
    const runId = queue.state().items[0].runId!
    await manager.whenIdle()
    expect(await queue.reply(runId, 'Once more.')).toBe('held')
    await new Promise((r) => setTimeout(r, 100))
    expect(manager.isLive(runId)).toBe(false)
    expect(queue.state().items[0]).toMatchObject({ status: 'queued', pendingReply: 'Once more.' })
    expect(pipeline.state()).toMatchObject({ status: 'stopped-budget', stopReason: expect.stringMatching(/\$0\.01 of \$0\.01/) })
    await pipeline.resume({ budget: { maxCostUsd: 1 } })
    await until((_p, q) => q.items[0].status === 'done' && !q.items[0].pendingReply)
    const events = await readEvents(ws, runId)
    expect(events.some((e) => (e as { text?: string }).text === 'Once more.')).toBe(true)
  })

  it('takes a re-run of a result whose queue item was removed back into the queue: slot, policy and verify gate', async () => {
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a'], { concurrency: 1 }))
    await until((p) => p?.status === 'finished' && finished.length > 0)
    const runId = queue.state().items[0].runId!
    await manager.whenIdle()
    await queue.clearFinished()
    expect(queue.state().items).toHaveLength(0)
    // An attended job takes the only slot.
    setJobs('url:busy')
    await queue.enqueue({ jobIds: ['url:busy'], options: { ...options, notes: 'STALL' }, concurrency: 1 })
    await until((_p, q) => q.items[0]?.status === 'running')
    expect(await queue.reply(runId, 'Once more.')).toBe('held')
    expect(manager.isLive(runId)).toBe(false)
    expect(queue.state().items.find((i) => i.runId === runId)).toMatchObject({ unattended: true, status: 'queued', pendingReply: 'Once more.' })
    // The slot frees up: the held reply goes first, and the verify gate settles the result.
    await queue.cancel(queue.state().items[0].id)
    await until((_p, q) => q.items.find((i) => i.runId === runId)?.status === 'done')
    expect(queue.state().items.find((i) => i.runId === runId)!.outcome).toBe('unreviewed')
    await until(() => !manager.isLive(runId))
    expect((await readRun(ws, runId)).status).toBe('finished')
  })

  it('revokes an approval before any continuation reaches the agent (a Tailor reply), so Apply is blocked during it', async () => {
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a'], { concurrency: 1 }))
    await until((p) => p?.status === 'finished' && finished.length > 0)
    const item = queue.state().items[0]
    const app = item.applicationId!
    const reviewDeps = { workspace: async () => ws, reply: async () => 'held' as const }
    const detail = await reviewDetail(ws, app)
    expect((await approveReview(reviewDeps, { applicationId: app, revision: detail.revision }, 'desktop')).ok).toBe(true)
    const gate = async () => reviewBlocker((await readApplication(ws, join(ws, app))).tracking.review)
    expect(await gate()).toBeNull()
    // The user answers on the Tailor page; the agent rewrites the result (here: it hangs mid-turn).
    await queue.reply(item.runId!, 'Shorten it. SECOND:STALL')
    await until((_p, q) => q.items[0].status === 'running')
    expect(await getReview(ws, app)).toMatchObject({ state: 'unreviewed', reason: expect.stringMatching(/Continued after review/) })
    expect(await gate()).toMatch(/Unreviewed/)
    expect(await approvalDrift(ws, app)).toBeNull()
  })

  it('keeps a Discard made while the verify gate runs, and keeps verify.py\'s report for Review when there is no build report', async () => {
    let release!: () => void
    const verifying = new Promise<void>((r) => (release = r))
    let calls = 0
    pipeline = new Pipeline(
      pipelineDeps({
        verify: async () => {
          calls++
          if (calls === 1) await verifying
          return calls === 1 ? { ok: true, report: 'page_count: pass' } : { ok: false, report: 'page_count: FAIL (3 pages)' }
        }
      })
    )
    jobs.set('url:a', job('url:a', { description: 'NO_REPORT' }))
    await pipeline.start(input(['url:a'], { concurrency: 1 }))
    await until(() => calls === 1)
    const run = (await readRun(ws, queue.state().items[0].runId!))
    const app = run.outputFolder!
    const reviewDeps = { workspace: async () => ws, reply: async () => 'held' as const }
    // Discard while verification is pending (allowed while the run works).
    const shown = await reviewDetail(ws, app)
    expect((await discardReview(reviewDeps, { applicationId: app, revision: shown.revision }, 'desktop')).ok).toBe(true)
    release()
    await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(await getReview(ws, app)).toMatchObject({ state: 'discarded', runId: run.id })
    // The queue item says so too, not Unreviewed (#72), and nothing waits for review.
    expect(queue.state().items[0].outcome).toBe('discarded')
    expect(pipeline.state()!.counts).toMatchObject({ unreviewed: 0, needsAttention: 0, discarded: 1 })
    expect(finished[0].counts).toMatchObject({ unreviewed: 0, discarded: 1 })
    expect(badges).toEqual([0])
    expect(reviewBlocker((await readApplication(ws, join(ws, app))).tracking.review)).toMatch(/discarded/)

    // Report-less results keep verify.py's own report (pass and fail) for Review.
    jobs.set('url:b', job('url:b', { description: 'NO_REPORT' }))
    await pipeline.dismiss()
    await pipeline.start(input(['url:b'], { concurrency: 1 }))
    await until((p) => p?.status === 'finished' && finished.length > 1)
    const b = queue.state().items.find((i) => i.jobId === 'url:b')!
    expect(b.outcome).toBe('needs-attention')
    const failed = await reviewDetail(ws, b.applicationId!)
    expect(failed.verify).toEqual({ ok: false, report: 'page_count: FAIL (3 pages)' })
    expect(failed.state).toBe('needs-attention')
    // The passing one (discarded above) shows its passing report too.
    expect((await reviewDetail(ws, app)).verify).toEqual({ ok: true, report: 'page_count: pass' })
  })

  it('follows Approve, Discard and Re-run from the Review page: items, counts, dock badge and summary (#72)', async () => {
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    jobs.set('url:b', job('url:b', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a', 'url:b'], { concurrency: 1 }))
    await until((p) => p?.status === 'finished' && finished.length > 0)
    expect(badges).toEqual([2])
    const [a, b] = ['url:a', 'url:b'].map((id) => queue.state().items.find((i) => i.jobId === id)!)
    // As the desktop wires it (review/ipc.ts): every decision syncs the queue.
    let syncs: Promise<void>[] = []
    const reviewDeps = {
      workspace: async () => ws,
      reply: async (runId: string, text: string) => (await queue.reply(runId, text))!,
      changed: () => void syncs.push(pipeline.syncReviews())
    }
    const settled = () => Promise.all(syncs)

    // An approval recorded for an older run of the same folder never touches this result.
    await updateReview(ws, a.applicationId!, (c) => ({ ...c!, state: 'approved', runId: 'older-run' }))
    await pipeline.syncReviews()
    expect(queue.state().items.find((i) => i.id === a.id)!.outcome).toBe('unreviewed')
    // Nor the Dashboard's summary: it still counts the result as waiting.
    expect((await pipeline.lastSummary())!.counts).toMatchObject({ unreviewed: 2, approved: 0 })
    expect(finished[0].items.find((i) => i.jobId === 'url:a')!.runId).toBe(a.runId)
    await updateReview(ws, a.applicationId!, (c) => ({ ...c!, state: 'unreviewed', runId: a.runId! }))

    const emitted = states.length
    const broadcasts = queueStates.length
    expect((await approveReview(reviewDeps, { applicationId: a.applicationId!, revision: (await reviewDetail(ws, a.applicationId!)).revision }, 'desktop')).ok).toBe(true)
    await settled()
    expect(queue.state().items.find((i) => i.id === a.id)!.outcome).toBe('approved')
    expect(queueStates.length).toBe(broadcasts + 1)
    expect(queueStates.at(-1)!.items.find((i) => i.id === a.id)!.outcome).toBe('approved')
    expect(states.length).toBeGreaterThan(emitted)
    expect(states.at(-1)!.counts).toMatchObject({ unreviewed: 1, approved: 1, discarded: 0 })
    expect(badges.at(-1)).toBe(1)
    expect(await pipeline.lastSummary()).toMatchObject({ counts: { unreviewed: 1, approved: 1 } })
    // Nothing changed: no save, no broadcast, no badge.
    await pipeline.syncReviews()
    expect(queueStates.length).toBe(broadcasts + 1)
    expect(badges).toEqual([2, 1])

    syncs = []
    expect((await discardReview(reviewDeps, { applicationId: b.applicationId!, revision: (await reviewDetail(ws, b.applicationId!)).revision }, 'desktop')).ok).toBe(true)
    await settled()
    expect(queue.state().items.find((i) => i.id === b.id)!.outcome).toBe('discarded')
    expect(pipeline.state()!.counts).toMatchObject({ unreviewed: 0, needsAttention: 0, approved: 1, discarded: 1 })
    expect(badges.at(-1)).toBe(0)
    const summary = (await pipeline.lastSummary())!
    expect(summary.counts).toMatchObject({ unreviewed: 0, needsAttention: 0, approved: 1, discarded: 1 })
    expect(summary.items.map((i) => i.outcome).sort()).toEqual(['approved', 'discarded'])
    // The file keeps what the pipeline ended with; the notification is not sent again.
    expect(JSON.parse(await readFile(summaryFile(ws), 'utf8')).counts.unreviewed).toBe(2)
    expect(notifications.filter((n) => n.category === 'pipeline-finished')).toHaveLength(1)

    // Re-run the approved one: it leaves `done`, then settles again like any result.
    syncs = []
    expect((await rerunReview(reviewDeps, { applicationId: a.applicationId!, revision: (await reviewDetail(ws, a.applicationId!)).revision, answers: 'Shorten it.' }, 'desktop')).ok).toBe(true)
    await settled()
    expect(queue.state().items.find((i) => i.id === a.id)!.status).not.toBe('done')
    await until((_p, q) => q.items.find((i) => i.id === a.id)!.status === 'done')
    expect(queue.state().items.find((i) => i.id === a.id)!.outcome).toBe('unreviewed')
    await until((p) => p?.status === 'finished')
    expect(pipeline.state()!.counts).toMatchObject({ unreviewed: 1, approved: 0, discarded: 1 })
  })

  it('fixes items saved with an old review state when the app starts (#72)', async () => {
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a'], { concurrency: 1 }))
    await until((p) => p?.status === 'finished' && finished.length > 0)
    const item = queue.state().items[0]
    // Approved while nothing synced (before this fix, or by another process).
    await updateReview(ws, item.applicationId!, (c) => ({ ...c!, state: 'approved' }))
    await pipeline.shutdown()
    await queue.shutdown()
    expect(JSON.parse(await readFile(queueFile(ws), 'utf8')).items[0].outcome).toBe('unreviewed')
    badges = []
    queue = new TailorQueue(queueDeps())
    pipeline = new Pipeline(pipelineDeps())
    await pipeline.init(0)
    expect(queue.state().items[0].outcome).toBe('approved')
    expect(pipeline.state()!.counts).toMatchObject({ unreviewed: 0, approved: 1 })
    // The dock starts without a badge and nothing waits for review: none is set.
    expect(badges).toEqual([])
    await queue.flush()
    expect(JSON.parse(await readFile(queueFile(ws), 'utf8')).items[0].outcome).toBe('approved')
    // A summary written before #72 has no run ids: the queue item's run stands in for it.
    const file = JSON.parse(await readFile(summaryFile(ws), 'utf8'))
    for (const i of file.items) delete i.runId
    await writeFile(summaryFile(ws), JSON.stringify(file))
    expect((await pipeline.lastSummary())!.counts).toMatchObject({ unreviewed: 0, approved: 1 })
  })

  it('fixes stale review states when another workspace\'s queue is loaded, not only at startup (#72)', async () => {
    jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
    await pipeline.start(input(['url:a'], { concurrency: 1 }))
    await until((p) => p?.status === 'finished' && finished.length > 0)
    const item = queue.state().items[0]
    await updateReview(ws, item.applicationId!, (c) => ({ ...c!, state: 'approved' }))
    await pipeline.shutdown()
    await queue.shutdown()
    // The app starts in another workspace, then the user opens this one.
    const saved = ws
    ws = await mkdtemp(join(tmpdir(), 'huntgry-pipeline-other-'))
    try {
      queue = new TailorQueue(queueDeps())
      pipeline = new Pipeline(pipelineDeps())
      await pipeline.init(0)
      expect(queue.state().items).toEqual([])
      await rm(ws, { recursive: true, force: true })
    } finally {
      ws = saved
    }
    await queue.sync()
    await until((_p, q) => q.items[0]?.outcome === 'approved')
    expect(pipeline.state()!.counts).toMatchObject({ unreviewed: 0, approved: 1 })
  })

  it('checks the opened workspace\'s pipeline, not the previous one\'s, before a start', async () => {
    await pipeline.init(0)
    expect(pipeline.state()).toBeNull()
    // The user opens another workspace whose saved pipeline is paused with a job still queued.
    const saved = ws
    ws = await mkdtemp(join(tmpdir(), 'huntgry-pipeline-other-'))
    try {
      const at = '2026-10-09T00:00:00.000Z'
      const id = 'p-20261009-000000-b2c3d4'
      const itemId = 'q-20261009-000000-c3d4e5'
      await mkdir(join(ws, '.huntgry'), { recursive: true })
      await writeFile(
        queueFile(ws),
        JSON.stringify({
          version: 1,
          concurrency: 1,
          items: [{ id: itemId, jobId: 'url:x', title: 'x', options, status: 'queued', runId: null, attempts: 0, createdAt: at, updatedAt: at, unattended: true, pipelineId: id }],
          pipeline: { id, status: 'paused', options: {}, itemIds: [itemId], skipped: [], limits: {}, unparsedStrikes: 0, startedAt: at, runCosts: {} }
        })
      )
      jobs.set('url:a', job('url:a', { description: 'WRITE_NOTES' }))
      const plan = await pipeline.plan(input(['url:a']))
      expect(plan.blockers).toContain('A pipeline is already running. Stop it, or wait for it to finish.')
      await expect(pipeline.start(input(['url:a']))).rejects.toThrow(/already running/)
      expect(JSON.parse(await readFile(queueFile(ws), 'utf8')).pipeline.id).toBe(id)
    } finally {
      await pipeline.shutdown()
      await queue.shutdown()
      await rm(ws, { recursive: true, force: true })
      ws = saved
    }
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
