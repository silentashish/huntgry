import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { PipelineSummary } from '@shared/pipeline-types'
import type { QueueOptions, QueueState } from '@shared/queue-types'
import type { AgentId, RunSummary } from '@shared/runner-types'
import { RunManager, type RunContext } from '../cli/runner'
import { folderSlug, listRuns, readRun } from '../cli/runs'
import { TailorQueue } from '../queue/queue'
import { Pipeline } from '../pipeline/pipeline'
import { setReviewAuthorityRoot } from '../review/authority'
import { pipelineTailor, resultOf, runCost } from './tailor'

/**
 * Automation's tailoring is the real unattended pipeline (#154 AC5): these tests drive `pipelineTailor` over a
 * real `TailorQueue` and `Pipeline` with the fake agent, like `pipeline.test.ts`.
 */

const FAKE_CLAUDE = join(__dirname, '../cli/fixtures/fake-claude.mjs')

let ws: string
let jobs: Map<string, Job>
let manager: RunManager
let queue: TailorQueue
let pipeline: Pipeline
let listeners: Set<(s: QueueState) => void>
let notifications: string[]
let finished: PipelineSummary[]
let notes: string

const job = (id: string): Job => {
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
    description: 'Build APIs in Go.',
    descriptionComplete: true,
    tags: [],
    fetchedAt: '2026-10-01T00:00:00.000Z'
  }
}

const ctx = (agent: AgentId = 'claude'): RunContext => ({
  agent,
  workspace: ws,
  skillDir: '/skills/resume-tailor',
  sandbox: { workspace: ws, skillDir: '/skills/resume-tailor', venvDir: '/venv', texRoot: null },
  command: process.execPath,
  commandPrefixArgs: [FAKE_CLAUDE],
  env: { ...process.env },
  systemPrompt: 'test'
})

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-automation-tailor-'))
  setReviewAuthorityRoot(`${ws}-authority`)
  jobs = new Map()
  listeners = new Set()
  notifications = []
  finished = []
  notes = 'WRITE_NOTES'
  manager = new RunManager({
    onEvent: () => undefined,
    onRun: (r: RunSummary) => {
      queue.onRun(r)
      pipeline.onRun(r)
    }
  })
  queue = new TailorQueue({
    workspace: async () => ws,
    findJob: async (_ws, id) => jobs.get(id) ?? null,
    fetchDetails: async (_ws, id) => jobs.get(id)!,
    markTailored: async () => undefined,
    start: async (params, agent) => manager.start(params, ctx(agent)),
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
    onChange: (s) => listeners.forEach((l) => l(s)),
    spawnGapMs: 0,
    retryDelayMs: 20
  })
  pipeline = new Pipeline({
    queue,
    workspace: async () => ws,
    findJob: async (_ws, id) => jobs.get(id) ?? null,
    fetchDetails: async (_ws, id) => jobs.get(id)!,
    // Like the app's scan of application folders: a job whose run built its folder counts as tailored before.
    tailoredJobIds: async () => new Set(queue.state().items.filter((i) => i.applicationId).map((i) => folderSlug(jobs.get(i.jobId)!.sourceId))),
    environment: async () => ({ agents: (['claude', 'codex', 'antigravity'] as AgentId[]).map((id) => ({ id, ready: true, problems: [] })), sharedProblems: [] }),
    freeDiskBytes: async () => 10 * 1024 ** 3,
    runHistory: async () => ({ medianMs: null, medianCostUsd: null }),
    verify: async () => ({ ok: false, report: 'no venv' }),
    liveRun: (id) => manager.liveRun(id),
    abort: (id, reason) => manager.abort(id, reason),
    notify: (category) => notifications.push(category),
    setBadge: () => undefined,
    keepAwake: () => undefined,
    onBattery: () => false,
    emit: () => undefined,
    emitFinished: (s) => finished.push(s),
    tickMs: 40,
    random: () => 0.5,
    burstRetryMs: 20
  })
})

afterEach(async () => {
  await pipeline.shutdown()
  await queue.shutdown()
  manager.stopAll()
  await manager.whenIdle()
  await rm(ws, { recursive: true, force: true })
  await rm(`${ws}-authority`, { recursive: true, force: true })
})

const tailor = () =>
  pipelineTailor({
    pipeline,
    queue,
    onQueueChange: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    agent: async () => 'claude',
    options: (coverLetter): QueueOptions => ({ coverLetter, dateStyle: 'right', notes }),
    listRuns,
    readRun: (w, id) => readRun(w, id).catch(() => null)
  })

const waitFor = async (pred: () => boolean, ms = 10_000) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('pipelineTailor', { timeout: 30_000 }, () => {
  it('tailors one job through a pipeline marked as Automation’s, and reports its review outcome and cost', async () => {
    jobs.set('url:a', job('url:a'))
    const t = tailor()
    expect(t.blocked(ws)).toBeNull()
    const { itemId } = await t.start(ws, 'url:a', { automationRunId: 'a-1', coverLetter: false })
    // The item is the pipeline's: unattended, tagged with the pipeline, and the pipeline is Automation's.
    const item = queue.state().items.find((i) => i.id === itemId)!
    expect(item).toMatchObject({ jobId: 'url:a', unattended: true })
    expect(item.pipelineId).toBe(pipeline.state()?.id)
    expect(pipeline.state()).toMatchObject({ origin: 'automation', concurrency: queue.state().concurrency })
    expect(queue.pipelineRecord()).toMatchObject({ origin: 'automation', automationRunId: 'a-1', options: { resumeAfterRestart: false } })
    // While it runs, another start must wait.
    expect(t.blocked(ws)).toMatch(/last tailoring run/)
    expect(t.item(itemId)).toBe('working')

    const result = await t.wait(itemId, new AbortController().signal)
    expect(result).toMatchObject({ status: 'done', outcome: 'unreviewed' })
    expect(result.applicationId).toBeTruthy()
    expect(result.runId).toBeTruthy()
    expect(await t.costUsd(ws, itemId)).toBeGreaterThan(0)
    await waitFor(() => pipeline.state()?.status === 'finished' && finished.length === 1)
    // Automation tells the user itself: no per-job "pipeline finished" notification.
    expect(notifications).not.toContain('pipeline-finished')
    expect(t.blocked(ws)).toBeNull()
    expect(await t.medianCostUsd(ws)).toBeGreaterThan(0)
  })

  it('a result that fails the verify gate comes back as needs-attention', async () => {
    jobs.set('url:b', job('url:b'))
    notes = 'VERIFY_FAIL'
    const t = tailor()
    const { itemId } = await t.start(ws, 'url:b', { automationRunId: 'a-2', coverLetter: false })
    expect(await t.wait(itemId, new AbortController().signal)).toMatchObject({ status: 'done', outcome: 'needs-attention' })
  })

  it('an explicit Retry gets past the tailored-before guard for a result that needs attention (one attempt, verify gate)', async () => {
    jobs.set('url:r', job('url:r'))
    notes = 'VERIFY_FAIL'
    const t = tailor()
    const first = await t.start(ws, 'url:r', { automationRunId: 'a-4', coverLetter: false })
    expect(await t.wait(first.itemId, new AbortController().signal)).toMatchObject({ status: 'done', outcome: 'needs-attention' })
    await waitFor(() => pipeline.state()?.status === 'finished')
    notes = 'WRITE_NOTES'
    // A new pick is refused (tailored before); the user's Retry is not.
    await expect(t.start(ws, 'url:r', { automationRunId: 'a-4', coverLetter: false })).rejects.toThrow(/Tailored before/)
    const retry = await t.start(ws, 'url:r', { automationRunId: 'a-4', coverLetter: false, retry: true })
    expect(retry.itemId).not.toBe(first.itemId)
    expect(await t.wait(retry.itemId, new AbortController().signal)).toMatchObject({ status: 'done', outcome: 'unreviewed' })
  })

  it('a wait ends at once when its run is stopped, whatever the queue does', async () => {
    jobs.set('url:s', job('url:s'))
    notes = 'SLOW WRITE_NOTES'
    const t = tailor()
    const { itemId } = await t.start(ws, 'url:s', { automationRunId: 'a-5', coverLetter: false })
    const abort = new AbortController()
    const waiting = t.wait(itemId, abort.signal)
    abort.abort()
    expect(await waiting).toEqual({ status: 'cancelled', aborted: true })
    await t.stop(ws)
  })

  it("waits for someone else's pipeline, and pauses or stops only its own", async () => {
    jobs.set('url:c', job('url:c'))
    jobs.set('url:d', job('url:d'))
    notes = 'SLOW WRITE_NOTES'
    await pipeline.start({ jobIds: ['url:c'], options: { coverLetter: false, dateStyle: 'right', notes }, agent: 'claude', concurrency: 1, resumeAfterRestart: true, skipTailored: true, stallMinutes: 5 })
    const t = tailor()
    expect(t.blocked(ws)).toBe('Waiting for the running pipeline to finish.')
    await t.pause(ws)
    await t.stop(ws)
    expect(pipeline.state()?.status).toBe('running')
    await waitFor(() => pipeline.state()?.status === 'finished')

    const { itemId } = await t.start(ws, 'url:d', { automationRunId: 'a-3', coverLetter: false })
    await t.pause(ws)
    expect(pipeline.state()?.status).toBe('paused')
    await t.resume(ws)
    expect(pipeline.state()?.status).toBe('running')
    await t.stop(ws)
    const r = await t.wait(itemId, new AbortController().signal)
    expect(['cancelled', 'done']).toContain(r.status)
  })

  it('waits while the queue is paused with jobs in it (a pipeline start would unpause them)', () => {
    const item = { id: 'q', jobId: 'url:e', title: 't', options: { coverLetter: false, dateStyle: 'right' as const }, agent: 'claude' as const, runId: null, attempts: 0, createdAt: '', updatedAt: '' }
    const paused = (status: 'queued' | 'done') =>
      pipelineTailor({
        pipeline: { state: () => null } as unknown as Pipeline,
        queue: { state: () => ({ items: [{ ...item, status }], concurrency: 2, paused: true }), isPaused: () => true, itemsOf: () => [] },
        onQueueChange: () => () => undefined,
        agent: async () => 'claude',
        options: (coverLetter) => ({ coverLetter, dateStyle: 'right' }),
        listRuns: async () => [],
        readRun: async () => null
      })
    expect(paused('queued').blocked(ws)).toMatch(/queue is paused/)
    expect(paused('done').blocked(ws)).toBeNull()
  })
})

describe('costUsd', () => {
  it('adds up every attempt of the item (a failed run the pipeline retried included)', async () => {
    const item = { id: 'q1', jobId: 'url:x', title: 't', options: { coverLetter: false, dateStyle: 'right' as const }, agent: 'claude' as const, runId: 'r2', attempts: 2, createdAt: '', updatedAt: '', status: 'done' as const, batchId: 'b-1' }
    const run = (id: string, batchId: string, cost: number) => ({ id, status: 'finished', unattended: true, costUsd: 0, totals: { estimatedCostUsd: cost }, params: { batchId } }) as unknown as RunSummary
    const t = pipelineTailor({
      pipeline: { state: () => null } as unknown as Pipeline,
      queue: { state: () => ({ items: [item], concurrency: 1, paused: false }), isPaused: () => false, itemsOf: () => [] },
      onQueueChange: () => () => undefined,
      agent: async () => 'claude',
      options: (coverLetter) => ({ coverLetter, dateStyle: 'right' }),
      listRuns: async () => [run('r1', 'b-1', 0.1), run('r2', 'b-1', 0.01), run('r3', 'b-other', 5)],
      readRun: async () => null
    })
    expect(await t.costUsd('/ws', 'q1')).toBe(0.11)
    expect(await t.costUsd('/ws', 'missing')).toBe(0)
  })
})

describe('resultOf / runCost', () => {
  it('reads a queue item as working or ended', () => {
    const base = { id: 'q', jobId: 'j', title: 't', options: { coverLetter: false, dateStyle: 'right' as const }, agent: 'claude' as const, runId: 'r', attempts: 1, createdAt: '', updatedAt: '' }
    expect(resultOf({ ...base, status: 'running' })).toBe('working')
    expect(resultOf({ ...base, status: 'queued' })).toBe('working')
    expect(resultOf({ ...base, status: 'done', outcome: 'unreviewed', applicationId: 'a/b/c' })).toEqual({ status: 'done', outcome: 'unreviewed', applicationId: 'a/b/c', runId: 'r' })
    expect(resultOf({ ...base, status: 'failed', error: 'boom' })).toEqual({ status: 'failed', runId: 'r', error: 'boom' })
    expect(resultOf({ ...base, status: 'needs-reply' })).toMatchObject({ status: 'needs-reply' })
  })

  it('prices a run from tokens for every agent, else Claude’s own figure', () => {
    expect(runCost(null)).toBe(0)
    expect(runCost({ costUsd: 0.4, totals: { estimatedCostUsd: 0.9 } } as RunSummary)).toBe(0.9)
    expect(runCost({ costUsd: 0.4, totals: { estimatedCostUsd: 0 } } as RunSummary)).toBe(0.4)
    expect(runCost({ costUsd: 0 } as RunSummary)).toBe(0)
  })
})
