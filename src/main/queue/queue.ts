import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canFetchDetails, JOB_ID_PATTERN, tailorPrefillFor, type Job } from '@shared/jobs-types'
import type { PipelineRecord } from '@shared/pipeline-types'
import {
  ACTIVE_STATUSES,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_ENQUEUE,
  type EnqueueInput,
  type EnqueueResult,
  type QueueAgent,
  type QueueFile,
  type QueueItem,
  type QueueOptions,
  type QueueState
} from '@shared/queue-types'
import { DEFAULT_AGENT, isAgentId, type AgentId, type RunSummary, type StartRunParams } from '@shared/runner-types'
import { MAX_TEXT } from '../cli/command'
import { newRunId } from '../cli/runs'
import { HUNTGRY_DIR } from '../workspace/constants'

/**
 * Bulk tailoring queue: starts one tailoring run per queued job, each with its
 * own agent, at most `concurrency` of them working at once and `spawnGapMs`
 * apart (Claude's server limits bursts of new sessions). A run that stops at the approval
 * step frees its slot; the user answers it on the Tailor page. Electron-free:
 * the app passes the workspace, the job store and the run starter in.
 *
 * Unattended items (#31) are the same items with `unattended` set: the queue
 * is still the one executor, but the policy (what a turn's end means, what a
 * failure means, whether a job may start now) comes from the pipeline through
 * `UnattendedHooks`. The pipeline's record is persisted here, in `queue.json`.
 */

export interface QueueDeps {
  /** Path of the open workspace (throws when none). */
  workspace(): Promise<string>
  /** The canonical saved job for an id or alias, or `null`. */
  findJob(workspace: string, id: string): Promise<Job | null>
  /** Loads the full posting of a job that has only a board summary (throws with a user-facing reason). */
  fetchDetails(workspace: string, id: string): Promise<Job>
  markTailored(workspace: string, id: string): Promise<unknown>
  /** Starts the run in `workspace`, refusing when another workspace is open by then. */
  start(params: StartRunParams, agent: QueueAgent, workspace: string): Promise<RunSummary>
  /** Stops a run: kills its process, or marks it stopped when it waits with none (Codex between turns). */
  stopRun(runId: string, workspace: string): void
  /** Ends an unattended run whose result is settled: closes stdin, or marks an idle run finished. */
  finishRun?(runId: string, workspace: string): void
  /** Ends the idle process of an unattended run that waits for the user; the run stays resumable. */
  releaseRun?(runId: string, workspace: string): void
  /** Sends the user's reply to a run (resuming its session if the process is gone). */
  reply(runId: string, text: string, workspace: string): Promise<RunSummary>
  onChange(state: QueueState): void
  now?(): number
  /** Minimum time between two spawns. */
  spawnGapMs?: number
  /** Delay before the automatic retry of a run the server rate-limited. */
  retryDelayMs?: number
}

/** What an unattended run's ended turn means (decided by the pipeline). */
export type Settlement =
  /** Built (or not): the result was recorded; the run is finished. */
  | { kind: 'done'; outcome: 'unreviewed' | 'needs-attention'; applicationId?: string; reason?: string }
  /** The agent stopped without building: send this one reply and keep the slot. */
  | { kind: 'nudge'; text: string }
  /** Stopped with a question again: wait for the user, session kept. */
  | { kind: 'needs-reply'; error: string }

/** What an unattended run's failure means (decided by the pipeline). */
export type FailureDecision =
  | {
      action: 'requeue'
      delayMs: number
      /** Absolute time to start again (ISO), when the exact moment matters (a limit's reset); wins over `delayMs`. */
      notBefore?: string
      countRetry: boolean
      error: string
      kind: string
      agent?: AgentId
    }
  | { action: 'fail'; error: string; kind: string }

export interface UnattendedHooks {
  /** May this unattended item start now? (limit, pause, budget, proactive rejection) */
  beforeLaunch(item: QueueItem): 'go' | 'hold'
  settle(item: QueueItem, run: RunSummary, workspace: string): Promise<Settlement>
  onFailure(item: QueueItem, run: RunSummary): FailureDecision
  /** The agent could not be started at all (signed out, missing, no skill): the queue paused. */
  onStartError(item: QueueItem, error: string): void
  /** The queue's items or pipeline record changed (after every broadcast). */
  onChange(): void
  /** The queue file was (re)loaded: the pipeline record found in it, or `null`. */
  onLoad(record: PipelineRecord | null): void
}

export const QUEUE_ITEM_PATTERN = /^q-\d{8}-\d{6}-[0-9a-f]{6}$/
export const QUEUE_FILE = 'queue.json'

export const INTERRUPTED = 'Huntgry was closed while this job was starting or running. Retry it.'
/** Bulk runs never start from a board summary: nobody is there to notice the resume was tailored to a snippet. */
export const PASTE_HINT = 'Open the posting, add its description with "Paste a job" on the Jobs page, and tailor that job.'
const RATE_LIMIT = /temporarily limiting requests|rate.?limit|too many requests|\b429\b|overloaded/i
/** A used-up quota (Antigravity answers 429 too) does not clear in seconds: no automatic retry. */
const QUOTA = /quota/i

const PIPELINE_STATUSES = ['running', 'paused', 'waiting-limit', 'stopped-budget', 'stopping', 'finished']

export const queueFile = (workspace: string): string => join(workspace, HUNTGRY_DIR, QUEUE_FILE)

export function requireItemId(id: unknown): string {
  if (typeof id !== 'string' || !QUEUE_ITEM_PATTERN.test(id)) throw new Error('Invalid queue item id.')
  return id
}

export function requireConcurrency(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY)
    throw new Error(`Concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.`)
  return n
}

export function requireAgent(agent: unknown): AgentId {
  if (!isAgentId(agent)) throw new Error('Unknown agent.')
  return agent
}

/** Checks what the renderer sends with "Tailor all"; `fallback` is the agent used when none is given. */
export function requireEnqueueInput(
  input: unknown,
  fallback: AgentId = DEFAULT_AGENT
): Required<Omit<EnqueueInput, 'concurrency' | 'unattended' | 'pipelineId'>> & {
  concurrency?: number
} {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (!Array.isArray(p.jobIds) || p.jobIds.length === 0) throw new Error('Select at least one job.')
  if (p.jobIds.length > MAX_ENQUEUE) throw new Error(`Select at most ${MAX_ENQUEUE} jobs at a time.`)
  for (const id of p.jobIds) if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) throw new Error('Invalid job id.')
  const o = (typeof p.options === 'object' && p.options !== null ? p.options : {}) as Record<string, unknown>
  if (typeof o.coverLetter !== 'boolean') throw new Error('Choose whether to write cover letters.')
  if (o.dateStyle !== 'inline' && o.dateStyle !== 'right') throw new Error('Invalid date style.')
  if (o.notes !== undefined && (typeof o.notes !== 'string' || o.notes.length > MAX_TEXT))
    throw new Error('The notes are too long.')
  if (p.agent !== undefined && !isAgentId(p.agent)) throw new Error('Unknown agent.')
  const options: QueueOptions = { coverLetter: o.coverLetter, dateStyle: o.dateStyle }
  if (typeof o.notes === 'string' && o.notes.trim()) options.notes = o.notes.trim()
  return {
    jobIds: [...new Set(p.jobIds as string[])],
    options,
    agent: p.agent === undefined ? fallback : (p.agent as AgentId),
    ...(p.concurrency !== undefined ? { concurrency: requireConcurrency(p.concurrency) } : {})
  }
}

/** Run parameters for a job with its full description. */
export function paramsForJob(job: Job, options: QueueOptions, unattended = false): StartRunParams {
  const prefill = tailorPrefillFor(job)
  return {
    jobDescription: prefill.jobDescription,
    jobUrl: prefill.jobUrl,
    company: prefill.company,
    role: prefill.role,
    jobId: prefill.jobId,
    source: prefill.source,
    coverLetter: options.coverLetter,
    dateStyle: options.dateStyle,
    ...(options.notes ? { notes: options.notes } : {}),
    ...(unattended ? { unattended: true as const } : {})
  }
}

const isActive = (i: QueueItem) => ACTIVE_STATUSES.includes(i.status)
const isWorking = (i: QueueItem) => i.status === 'preparing' || i.status === 'running'
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A pipeline record from disk, or `null` when it is not one. */
function readRecord(v: unknown): PipelineRecord | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || !PIPELINE_STATUSES.includes(r.status as string)) return null
  if (typeof r.options !== 'object' || r.options === null || !Array.isArray(r.itemIds)) return null
  return {
    ...(r as unknown as PipelineRecord),
    limits: typeof r.limits === 'object' && r.limits !== null ? (r.limits as PipelineRecord['limits']) : {},
    runCosts: typeof r.runCosts === 'object' && r.runCosts !== null ? (r.runCosts as Record<string, number>) : {},
    skipped: Array.isArray(r.skipped) ? (r.skipped as PipelineRecord['skipped']) : [],
    unparsedStrikes: typeof r.unparsedStrikes === 'number' ? r.unparsedStrikes : 0,
    estimateMsPerJob: typeof r.estimateMsPerJob === 'number' ? r.estimateMsPerJob : null
  }
}

export class TailorQueue {
  private ws: string | null = null
  private items: QueueItem[] = []
  private concurrency = DEFAULT_CONCURRENCY
  private paused = true
  private lastSpawn = Number.NEGATIVE_INFINITY
  private pumping = false
  private pumpAgain = false
  private timer: NodeJS.Timeout | null = null
  private saving: Promise<void> = Promise.resolve()
  /** Summaries of runs that arrived before `start` returned their id. */
  private early = new Map<string, RunSummary>()
  /** Items whose run already reached a reply; a later failure is not a first-turn rate limit. */
  private answered = new Set<string>()
  /** Unattended items whose ended turn is being settled (the settle hook is async). */
  private settling = new Set<string>()
  private stopped = false
  private hooks: UnattendedHooks | null = null
  /** The pipeline record kept in the queue file (owned by the pipeline). */
  private pipeline: PipelineRecord | null = null

  constructor(private deps: QueueDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The pipeline attaches its policy once; without it unattended items behave like attended ones. */
  setUnattendedHooks(hooks: UnattendedHooks | null): void {
    this.hooks = hooks
  }

  state(): QueueState {
    return { items: this.items.map((i) => ({ ...i })), concurrency: this.concurrency, paused: this.paused }
  }

  /** The workspace whose queue is loaded (`null` before the first sync). */
  workspace(): string | null {
    return this.ws
  }

  pipelineRecord(): PipelineRecord | null {
    return this.pipeline
  }

  /** The pipeline saves its record here (persisted with the items). */
  savePipeline(record: PipelineRecord | null): void {
    this.pipeline = record
    this.save()
  }

  /** Items of one pipeline, in queue order. */
  itemsOf(pipelineId: string): QueueItem[] {
    return this.items.filter((i) => i.pipelineId === pipelineId).map((i) => ({ ...i }))
  }

  /** Saves, broadcasts and starts what can start (the pipeline calls this after changing its policy). */
  kick(): void {
    if (this.ws) this.changed()
  }

  /** Loads the queue of the open workspace when it changed (first call, workspace switch). */
  async sync(): Promise<QueueState> {
    const ws = await this.deps.workspace()
    if (ws !== this.ws) await this.load(ws)
    return this.state()
  }

  private async load(ws: string): Promise<void> {
    await this.saving
    this.clearTimer()
    this.ws = ws
    this.items = []
    this.concurrency = DEFAULT_CONCURRENCY
    this.early.clear()
    this.answered.clear()
    this.settling.clear()
    this.pipeline = null
    // Nothing starts on its own after a restart or a workspace switch: starting costs money.
    // The one exception is an unattended pipeline the user asked to resume after a restart.
    this.paused = true
    let raw: Partial<QueueFile> & { pipeline?: unknown }
    try {
      raw = JSON.parse(await readFile(queueFile(ws), 'utf8'))
    } catch {
      this.hooks?.onLoad(null)
      return
    }
    if (typeof raw.concurrency === 'number') {
      this.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(raw.concurrency)))
    }
    const at = new Date(this.now()).toISOString()
    const record = readRecord(raw.pipeline)
    const resume =
      record !== null &&
      (record.status === 'running' || record.status === 'waiting-limit') &&
      record.options.resumeAfterRestart === true
    this.items = (Array.isArray(raw.items) ? (raw.items as QueueItem[]) : [])
      .filter((i) => i && QUEUE_ITEM_PATTERN.test(i.id) && JOB_ID_PATTERN.test(i.jobId))
      .map((i) => ({ ...i, agent: isAgentId(i.agent) ? i.agent : DEFAULT_AGENT }))
      .map((i) => {
        if (!isWorking(i)) return i
        // An unattended item is queued again once; attended items (and a second interruption) fail.
        if (i.unattended && !i.interruptedOnce) {
          return {
            ...i,
            status: 'queued' as const,
            runId: null,
            error: undefined,
            built: undefined,
            pendingReply: undefined,
            notBefore: undefined,
            interruptedOnce: true as const,
            updatedAt: at
          }
        }
        return { ...i, status: 'failed' as const, error: INTERRUPTED, notBefore: undefined, updatedAt: at }
      })
    if (record && (record.status === 'running' || record.status === 'waiting-limit')) {
      record.interruptedAt = at
      if (!resume) record.status = 'paused'
    }
    this.pipeline = record
    this.paused = !resume
    this.hooks?.onLoad(record)
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    await this.sync()
    const ws = this.ws!
    const skipped: EnqueueResult['skipped'] = []
    let added = 0
    if (input.concurrency !== undefined) this.concurrency = requireConcurrency(input.concurrency)
    const at = new Date(this.now()).toISOString()
    for (const id of input.jobIds) {
      const job = await this.deps.findJob(ws, id)
      if (!job) {
        skipped.push({ jobId: id, reason: 'This job is no longer saved.' })
        continue
      }
      if (job.dismissed) {
        skipped.push({ jobId: job.id, reason: 'Dismissed jobs are not tailored.' })
        continue
      }
      if (this.items.some((i) => i.jobId === job.id && isActive(i))) {
        skipped.push({ jobId: job.id, reason: 'Already in the queue.' })
        continue
      }
      this.items.push({
        id: `q-${newRunId(new Date(this.now()))}`,
        jobId: job.id,
        title: [job.title, job.company].filter(Boolean).join(' · '),
        options: { ...input.options },
        agent: input.agent ?? DEFAULT_AGENT,
        status: 'queued',
        runId: null,
        attempts: 0,
        createdAt: at,
        updatedAt: at,
        ...(input.unattended ? { unattended: true as const, retries: 0 } : {}),
        ...(input.pipelineId ? { pipelineId: input.pipelineId } : {})
      })
      added++
    }
    // Queuing jobs is the user asking for them to start.
    if (added > 0) this.paused = false
    this.changed()
    return { state: this.state(), added, skipped }
  }

  async cancel(itemId: string): Promise<QueueState> {
    await this.sync()
    const item = this.find(itemId)
    if (isActive(item)) this.cancelItem(item)
    this.changed()
    return this.state()
  }

  async cancelAll(): Promise<QueueState> {
    await this.sync()
    for (const item of this.items) if (isActive(item)) this.cancelItem(item)
    this.changed()
    return this.state()
  }

  /** Stop of a pipeline: its queued items are dropped and its running ones stopped; done items stay. */
  cancelPipeline(pipelineId: string): void {
    for (const item of this.items) if (item.pipelineId === pipelineId && isActive(item)) this.cancelItem(item)
    this.changed()
  }

  /** Fallback agent: the pipeline's items that have not started yet switch to `agent`. */
  switchAgent(pipelineId: string, from: AgentId, to: AgentId): number {
    let n = 0
    const at = new Date(this.now()).toISOString()
    for (const item of this.items) {
      if (item.pipelineId !== pipelineId || item.status !== 'queued' || item.runId || item.agent !== from) continue
      item.agent = to
      item.updatedAt = at
      n++
    }
    if (n > 0) this.changed()
    return n
  }

  async retry(itemId: string): Promise<QueueState> {
    await this.sync()
    const item = this.find(itemId)
    if (item.status !== 'failed' && item.status !== 'cancelled') throw new Error('Only failed or cancelled jobs can be retried.')
    if (this.items.some((i) => i !== item && i.jobId === item.jobId && isActive(i)))
      throw new Error('This job is already in the queue.')
    this.requeue(item, 0)
    item.retries = item.unattended ? 0 : item.retries
    item.nudged = undefined
    this.paused = false
    this.changed()
    return this.state()
  }

  async remove(itemId: string): Promise<QueueState> {
    await this.sync()
    const item = this.find(itemId)
    if (isWorking(item)) throw new Error('Cancel this job before removing it.')
    this.items = this.items.filter((i) => i !== item)
    this.changed()
    return this.state()
  }

  async clearFinished(): Promise<QueueState> {
    await this.sync()
    this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'cancelled')
    this.changed()
    return this.state()
  }

  async setConcurrency(n: number): Promise<QueueState> {
    await this.sync()
    this.concurrency = requireConcurrency(n)
    this.changed()
    return this.state()
  }

  async setPaused(paused: boolean): Promise<QueueState> {
    await this.sync()
    this.paused = paused
    this.changed()
    return this.state()
  }

  isPaused(): boolean {
    return this.paused
  }

  /** Per-job override of the agent chosen for the whole request, until the job starts. */
  async setAgent(itemId: string, agent: AgentId): Promise<QueueState> {
    await this.sync()
    const item = this.find(itemId)
    // A failed or cancelled job starts a new run when retried.
    const notStarted = item.status === 'queued' && !item.runId
    if (!notStarted && item.status !== 'failed' && item.status !== 'cancelled')
      throw new Error('The agent can only be changed before the job starts.')
    item.agent = agent
    item.updatedAt = new Date(this.now()).toISOString()
    this.changed()
    return this.state()
  }

  /**
   * A reply the user typed for a run. A queue run waiting for its reply takes a slot again
   * once answered, so when `concurrency` runs are already working the reply is held (the
   * item goes back to `queued`) and sent before any new job starts. Returns the run when the
   * reply was sent, `'held'` when it waits for a slot, or `null` for a run the queue does not
   * manage (the caller sends it as usual). A done unattended item can be re-run this way
   * (the Review page's "Re-run with my answers").
   */
  async reply(runId: string, text: string): Promise<RunSummary | 'held' | null> {
    if (this.stopped) return null
    const ws = await this.deps.workspace().catch(() => null)
    if (!ws || ws !== this.ws) return null
    const item = this.items.find(
      (i) => i.runId === runId && (i.status === 'needs-reply' || (i.status === 'done' && i.unattended))
    )
    if (!item) return null
    if (item.status === 'done') {
      item.outcome = undefined
      item.applicationId = undefined
      item.nudged = undefined
    }
    // Pausing stops new jobs from starting; it does not hold the user's answers.
    if (this.items.filter(isWorking).length < this.concurrency) return this.sendReply(item, text)
    item.status = 'queued'
    item.pendingReply = text
    item.error = undefined
    item.updatedAt = new Date(this.now()).toISOString()
    this.changed()
    return 'held'
  }

  /** Takes a slot for the item and sends the reply; on failure the item waits for the user again. */
  private async sendReply(item: QueueItem, text: string): Promise<RunSummary> {
    item.status = 'running'
    item.pendingReply = undefined
    item.error = undefined
    item.updatedAt = new Date(this.now()).toISOString()
    this.save()
    this.broadcast()
    try {
      return await this.deps.reply(item.runId!, text, this.ws!)
    } catch (err) {
      if (item.status === 'running') {
        item.status = 'needs-reply'
        this.save()
        this.broadcast()
      }
      throw err
    }
  }

  /** Sends a held reply now that a slot is free. */
  private async sendHeld(item: QueueItem): Promise<void> {
    try {
      await this.sendReply(item, item.pendingReply!)
    } catch (err) {
      item.error = `Your reply could not be sent: ${message(err)}`
      this.save()
      this.broadcast()
    }
  }

  /**
   * Follows a run's status. `waiting` frees the slot (the user has to answer);
   * a first-turn rate limit is retried once, automatically. Unattended items
   * are settled or retried as the pipeline decides.
   */
  onRun(run: RunSummary): void {
    if (this.stopped) return
    const item = this.items.find((i) => i.runId === run.id)
    if (!item) {
      if (this.items.some((i) => i.status === 'preparing')) this.early.set(run.id, run)
      return
    }
    if (item.status === 'cancelled' || item.status === 'done' || item.status === 'failed') return
    this.apply(item, run)
    this.changed()
  }

  /** Stops following runs and saves, before the app kills the processes on quit. */
  async shutdown(): Promise<void> {
    this.stopped = true
    this.clearTimer()
    await this.saving
  }

  /** Resolves once the queue file is written (tests). */
  async flush(): Promise<void> {
    await this.saving
  }

  private apply(item: QueueItem, run: RunSummary): void {
    if (run.outputFiles.includes('resume.pdf')) item.built = true
    const unattended = item.unattended && this.hooks
    switch (run.status) {
      case 'running':
        item.status = 'running'
        break
      case 'waiting':
        if (!unattended) {
          item.status = 'needs-reply'
          this.answered.add(item.id)
        } else if (run.error) {
          // The turn ended with an error (usage limit, failed turn): the process is about to exit, or
          // stays idle; either way the item is retried or failed now and the process stopped.
          this.decide(item, run)
        } else if (item.status === 'running') {
          void this.settle(item, run)
        }
        break
      case 'finished':
        item.status = 'done'
        break
      case 'stopped':
        item.status = 'cancelled'
        break
      case 'failed':
        if (unattended) {
          // A run that already built the resume goes to the verify gate instead of a retry.
          if (run.outputFiles.includes('resume.pdf') && run.outputFolder) void this.settle(item, run, true)
          else this.decide(item, run)
        } else if (
          item.attempts === 0 &&
          !this.answered.has(item.id) &&
          RATE_LIMIT.test(run.error ?? '') &&
          !QUOTA.test(run.error ?? '')
        ) {
          this.requeue(item, this.deps.retryDelayMs ?? 15_000)
          item.error = `The agent's servers limited new sessions; retrying automatically. (${run.error})`
        } else {
          item.status = 'failed'
          item.error = run.error ?? 'The run failed.'
        }
        break
    }
    item.updatedAt = new Date(this.now()).toISOString()
  }

  /** Applies the pipeline's decision about a failed unattended run. */
  private decide(item: QueueItem, run: RunSummary): void {
    const d = this.hooks!.onFailure(item, run)
    const runId = run.id
    item.lastFailure = d.kind
    if (d.action === 'requeue') {
      this.requeue(item, d.delayMs, d.countRetry)
      if (d.notBefore) item.notBefore = d.notBefore
      item.error = d.error
      if (d.agent) item.agent = d.agent
    } else {
      item.status = 'failed'
      item.error = d.error
    }
    // The process may still be alive (an error result without an exit): its later summaries no
    // longer match the item (the run id is cleared on requeue) or are ignored (failed items).
    if (run.live) this.deps.stopRun(runId, this.ws!)
  }

  /** Lets the pipeline decide what an unattended run's ended turn means, then applies it. */
  private async settle(item: QueueItem, run: RunSummary, processGone = false): Promise<void> {
    if (this.settling.has(item.id)) return
    this.settling.add(item.id)
    let s: Settlement
    try {
      s = await this.hooks!.settle(item, run, this.ws!)
    } catch (err) {
      s = { kind: 'needs-reply', error: `The result could not be checked: ${message(err)}` }
    } finally {
      this.settling.delete(item.id)
    }
    // Cancelled, retried or another workspace meanwhile.
    if (item.runId !== run.id || (item.status !== 'running' && item.status !== 'needs-reply')) return
    switch (s.kind) {
      case 'done':
        item.outcome = s.outcome
        item.applicationId = s.applicationId
        item.error = s.reason
        if (processGone) item.status = 'done'
        else if (this.deps.finishRun) this.deps.finishRun(run.id, this.ws!)
        else item.status = 'done'
        break
      case 'nudge':
        item.nudged = true
        return this.nudge(item, s.text)
      case 'needs-reply':
        item.status = 'needs-reply'
        item.error = s.error
        this.answered.add(item.id)
        this.deps.releaseRun?.(run.id, this.ws!)
        break
    }
    item.updatedAt = new Date(this.now()).toISOString()
    this.changed()
  }

  private async nudge(item: QueueItem, text: string): Promise<void> {
    item.status = 'running'
    item.error = undefined
    item.updatedAt = new Date(this.now()).toISOString()
    this.changed()
    try {
      await this.deps.reply(item.runId!, text, this.ws!)
    } catch (err) {
      if (item.status === 'running') {
        item.status = 'needs-reply'
        item.error = `Stopped without building and could not be continued: ${message(err)}`
        this.answered.add(item.id)
        this.deps.releaseRun?.(item.runId!, this.ws!)
        this.changed()
      }
    }
  }

  private requeue(item: QueueItem, delayMs: number, countRetry = false): void {
    item.status = 'queued'
    item.runId = null
    item.error = undefined
    item.built = undefined
    item.pendingReply = undefined
    item.attempts++
    if (countRetry) item.retries = (item.retries ?? 0) + 1
    item.notBefore = delayMs > 0 ? new Date(this.now() + delayMs).toISOString() : undefined
    item.updatedAt = new Date(this.now()).toISOString()
    this.answered.delete(item.id)
  }

  private cancelItem(item: QueueItem): void {
    // A started run is stopped; its `stopped` summary is ignored since the item is already cancelled.
    // A queued item has no run, unless its reply is held: then its waiting run is stopped too.
    if (item.runId) this.deps.stopRun(item.runId, this.ws!)
    item.status = 'cancelled'
    item.pendingReply = undefined
    item.notBefore = undefined
    item.updatedAt = new Date(this.now()).toISOString()
  }

  private find(id: string): QueueItem {
    const item = this.items.find((i) => i.id === id)
    if (!item) throw new Error('This job is no longer in the queue.')
    return item
  }

  /** Saves, broadcasts and starts what can start. */
  private changed(): void {
    this.save()
    this.broadcast()
    void this.pump()
  }

  private broadcast(): void {
    this.deps.onChange(this.state())
    this.hooks?.onChange()
  }

  private save(): void {
    const ws = this.ws
    if (!ws) return
    const file: QueueFile = { version: 1, concurrency: this.concurrency, items: this.items, pipeline: this.pipeline }
    const body = `${JSON.stringify(file, null, 2)}\n`
    this.saving = this.saving
      .then(async () => {
        const path = queueFile(ws)
        await mkdir(join(ws, HUNTGRY_DIR), { recursive: true })
        const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
        await writeFile(tmp, body, 'utf8')
        await rename(tmp, path)
      })
      .catch((err) => console.error('Saving the tailoring queue failed:', err))
  }

  private nextQueued(): QueueItem | undefined {
    const now = this.now()
    return this.items.find(
      (i) =>
        i.status === 'queued' &&
        !i.pendingReply &&
        (!i.notBefore || Date.parse(i.notBefore) <= now) &&
        (!i.unattended || !this.hooks || this.hooks.beforeLaunch(i) === 'go')
    )
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        for (;;) {
          if (this.stopped || !this.ws) break
          if (this.items.filter(isWorking).length >= this.concurrency) break
          // Answers to runs already under way go before new jobs, paused or not.
          const held = this.items.find((i) => i.status === 'queued' && i.pendingReply && i.runId)
          if (held) {
            await this.sendHeld(held)
            continue
          }
          if (this.paused) break
          const next = this.nextQueued()
          if (!next) break
          const wait = this.lastSpawn + (this.deps.spawnGapMs ?? 2000) - this.now()
          if (wait > 0) {
            // Re-check everything afterwards: the item may be cancelled or the queue paused meanwhile.
            await new Promise((r) => setTimeout(r, wait))
            continue
          }
          await this.launch(next)
        }
      } while (this.pumpAgain)
    } finally {
      this.pumping = false
    }
    this.scheduleDeferred()
  }

  /** Wakes the queue when a delayed retry becomes due. */
  private scheduleDeferred(): void {
    this.clearTimer()
    if (this.stopped || this.paused) return
    const due = this.items
      .filter((i) => i.status === 'queued' && i.notBefore)
      .map((i) => Date.parse(i.notBefore!))
      .filter((t) => t > this.now())
    if (due.length === 0) return
    this.timer = setTimeout(() => void this.pump(), Math.min(...due) - this.now() + 5)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async launch(item: QueueItem): Promise<void> {
    const ws = this.ws!
    item.status = 'preparing'
    item.notBefore = undefined
    item.error = undefined
    item.updatedAt = new Date(this.now()).toISOString()
    this.save()
    this.broadcast()
    let params: StartRunParams
    try {
      params = await this.resolve(ws, item)
    } catch (err) {
      if (item.status === 'preparing') this.fail(item, message(err))
      return
    }
    if (item.status !== 'preparing' || this.ws !== ws || this.stopped) return
    let run: RunSummary
    try {
      this.lastSpawn = this.now()
      run = await this.deps.start(params, item.agent, ws)
    } catch (err) {
      // The user opened another workspace meanwhile: this item belongs to the old queue, which is gone.
      if (this.ws !== ws) return
      // Starting fails before any agent process for reasons that are not about this job (agent
      // signed out, too old or missing, no skill): pause, so the other jobs wait for the fix
      // instead of failing one after another. Resume or Retry once it is fixed.
      if (item.status === 'preparing') {
        this.paused = true
        item.lastFailure = 'start-error'
        this.fail(item, message(err))
        if (item.unattended) this.hooks?.onStartError(item, message(err))
      }
      return
    }
    item.runId = run.id
    item.startedAt ??= new Date(this.now()).toISOString()
    if (item.status !== 'preparing') {
      // Cancelled while the agent was starting.
      this.deps.stopRun(run.id, ws)
      return
    }
    this.apply(item, this.early.get(run.id) ?? run)
    this.early.clear()
    await this.deps.markTailored(ws, item.jobId).catch(() => undefined)
    this.save()
    this.broadcast()
  }

  /** The job's run parameters, with its full posting; a job with only a summary fails. */
  private async resolve(ws: string, item: QueueItem): Promise<StartRunParams> {
    let job = await this.deps.findJob(ws, item.jobId)
    if (!job) throw new Error('This job is no longer saved.')
    if (!job.descriptionComplete) {
      if (!canFetchDetails(job)) {
        throw new Error(`Indeed shows full job descriptions only after a human check. ${PASTE_HINT}`)
      }
      try {
        job = await this.deps.fetchDetails(ws, job.id)
      } catch (err) {
        // fetchDetails ends with advice for the drawer ("the summary is kept"); the queue gives its own.
        const reason = message(err).replace(/\s*The summary from the job board is kept;.*$/, '')
        throw new Error(`${reason} ${PASTE_HINT}`)
      }
      if (!job.descriptionComplete) throw new Error(`Only part of the posting could be read. ${PASTE_HINT}`)
    }
    return paramsForJob(job, item.options, item.unattended === true)
  }

  private fail(item: QueueItem, error: string): void {
    item.status = 'failed'
    item.error = error
    item.updatedAt = new Date(this.now()).toISOString()
    this.save()
    this.broadcast()
  }
}
