import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canFetchDetails, JOB_ID_PATTERN, tailorPrefillFor, type Job } from '@shared/jobs-types'
import {
  ACTIVE_STATUSES,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_ENQUEUE,
  type EnqueueInput,
  type EnqueueResult,
  type QueueAgent,
  type QueueItem,
  type QueueOptions,
  type QueueState
} from '@shared/queue-types'
import type { RunSummary, StartRunParams } from '@shared/runner-types'
import { MAX_TEXT } from '../cli/command'
import { newRunId } from '../cli/runs'
import { HUNTGRY_DIR } from '../workspace/constants'

/**
 * Bulk tailoring queue: starts one tailoring run per queued job, at most
 * `concurrency` of them working at once and `spawnGapMs` apart (Claude's
 * server limits bursts of new sessions). A run that stops at the approval
 * step frees its slot; the user answers it on the Tailor page. Electron-free:
 * the app passes the workspace, the job store and the run starter in.
 */

export interface QueueDeps {
  /** Path of the open workspace (throws when none). */
  workspace(): Promise<string>
  /** The canonical saved job for an id or alias, or `null`. */
  findJob(workspace: string, id: string): Promise<Job | null>
  /** Loads the full posting of a job that has only a board summary (throws with a user-facing reason). */
  fetchDetails(workspace: string, id: string): Promise<Job>
  markTailored(workspace: string, id: string): Promise<unknown>
  start(params: StartRunParams, agent: QueueAgent): Promise<RunSummary>
  stopRun(runId: string): void
  onChange(state: QueueState): void
  now?(): number
  /** Minimum time between two spawns. */
  spawnGapMs?: number
  /** Delay before the automatic retry of a run the server rate-limited. */
  retryDelayMs?: number
}

export const QUEUE_ITEM_PATTERN = /^q-\d{8}-\d{6}-[0-9a-f]{6}$/
export const QUEUE_FILE = 'queue.json'

const INTERRUPTED = 'Huntgry was closed while this job was starting or running. Retry it.'
/** Bulk runs never start from a board summary: nobody is there to notice the resume was tailored to a snippet. */
const PASTE_HINT = 'Open the posting, add its description with "Paste a job" on the Jobs page, and tailor that job.'
const RATE_LIMIT = /temporarily limiting requests|rate.?limit|too many requests|\b429\b|overloaded/i

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

/** Checks what the renderer sends with "Tailor all". */
export function requireEnqueueInput(input: unknown): Required<Omit<EnqueueInput, 'concurrency'>> & {
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
  if (p.agent !== undefined && p.agent !== 'claude') throw new Error('Unknown agent.')
  const options: QueueOptions = { coverLetter: o.coverLetter, dateStyle: o.dateStyle }
  if (typeof o.notes === 'string' && o.notes.trim()) options.notes = o.notes.trim()
  return {
    jobIds: [...new Set(p.jobIds as string[])],
    options,
    agent: 'claude',
    ...(p.concurrency !== undefined ? { concurrency: requireConcurrency(p.concurrency) } : {})
  }
}

/** Run parameters for a job with its full description. */
export function paramsForJob(job: Job, options: QueueOptions): StartRunParams {
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
    ...(options.notes ? { notes: options.notes } : {})
  }
}

const isActive = (i: QueueItem) => ACTIVE_STATUSES.includes(i.status)
const isWorking = (i: QueueItem) => i.status === 'preparing' || i.status === 'running'
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

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
  private stopped = false

  constructor(private deps: QueueDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  state(): QueueState {
    return { items: this.items.map((i) => ({ ...i })), concurrency: this.concurrency, paused: this.paused }
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
    // Nothing starts on its own after a restart or a workspace switch: starting costs money.
    this.paused = true
    let raw: { version?: number; concurrency?: unknown; items?: unknown }
    try {
      raw = JSON.parse(await readFile(queueFile(ws), 'utf8'))
    } catch {
      return
    }
    if (typeof raw.concurrency === 'number') {
      this.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(raw.concurrency)))
    }
    const at = new Date(this.now()).toISOString()
    this.items = (Array.isArray(raw.items) ? (raw.items as QueueItem[]) : [])
      .filter((i) => i && QUEUE_ITEM_PATTERN.test(i.id) && JOB_ID_PATTERN.test(i.jobId))
      .map((i) => (isWorking(i) ? { ...i, status: 'failed', error: INTERRUPTED, notBefore: undefined, updatedAt: at } : i))
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
        agent: input.agent ?? 'claude',
        status: 'queued',
        runId: null,
        attempts: 0,
        createdAt: at,
        updatedAt: at
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

  async retry(itemId: string): Promise<QueueState> {
    await this.sync()
    const item = this.find(itemId)
    if (item.status !== 'failed' && item.status !== 'cancelled') throw new Error('Only failed or cancelled jobs can be retried.')
    if (this.items.some((i) => i !== item && i.jobId === item.jobId && isActive(i)))
      throw new Error('This job is already in the queue.')
    this.requeue(item, 0)
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

  /**
   * Follows a run's status. `waiting` frees the slot (the user has to answer);
   * a first-turn rate limit is retried once, automatically.
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
    switch (run.status) {
      case 'running':
        item.status = 'running'
        break
      case 'waiting':
        item.status = 'needs-reply'
        this.answered.add(item.id)
        break
      case 'finished':
        item.status = 'done'
        break
      case 'stopped':
        item.status = 'cancelled'
        break
      case 'failed':
        if (item.attempts === 0 && !this.answered.has(item.id) && RATE_LIMIT.test(run.error ?? '')) {
          this.requeue(item, this.deps.retryDelayMs ?? 15_000)
          item.error = `Claude's servers limited new sessions; retrying automatically. (${run.error})`
        } else {
          item.status = 'failed'
          item.error = run.error ?? 'The run failed.'
        }
        break
    }
    item.updatedAt = new Date(this.now()).toISOString()
  }

  private requeue(item: QueueItem, delayMs: number): void {
    item.status = 'queued'
    item.runId = null
    item.error = undefined
    item.built = undefined
    item.attempts++
    item.notBefore = delayMs > 0 ? new Date(this.now() + delayMs).toISOString() : undefined
    item.updatedAt = new Date(this.now()).toISOString()
    this.answered.delete(item.id)
  }

  private cancelItem(item: QueueItem): void {
    // A started run is stopped; its `stopped` summary is ignored since the item is already cancelled.
    if (item.runId && item.status !== 'queued') this.deps.stopRun(item.runId)
    item.status = 'cancelled'
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
    this.deps.onChange(this.state())
    void this.pump()
  }

  private save(): void {
    const ws = this.ws
    if (!ws) return
    const body = `${JSON.stringify({ version: 1, concurrency: this.concurrency, items: this.items }, null, 2)}\n`
    this.saving = this.saving
      .then(async () => {
        const file = queueFile(ws)
        await mkdir(join(ws, HUNTGRY_DIR), { recursive: true })
        const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
        await writeFile(tmp, body, 'utf8')
        await rename(tmp, file)
      })
      .catch((err) => console.error('Saving the tailoring queue failed:', err))
  }

  private nextQueued(): QueueItem | undefined {
    const now = this.now()
    return this.items.find((i) => i.status === 'queued' && (!i.notBefore || Date.parse(i.notBefore) <= now))
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
          if (this.stopped || this.paused || !this.ws) break
          if (this.items.filter(isWorking).length >= this.concurrency) break
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
    this.deps.onChange(this.state())
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
      run = await this.deps.start(params, item.agent)
    } catch (err) {
      if (item.status === 'preparing') this.fail(item, message(err))
      return
    }
    item.runId = run.id
    if (item.status !== 'preparing') {
      // Cancelled while Claude was starting.
      this.deps.stopRun(run.id)
      return
    }
    this.apply(item, this.early.get(run.id) ?? run)
    this.early.clear()
    await this.deps.markTailored(ws, item.jobId).catch(() => undefined)
    this.save()
    this.deps.onChange(this.state())
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
        throw new Error(`${message(err)} ${PASTE_HINT}`)
      }
      if (!job.descriptionComplete) throw new Error(`Only part of the posting could be read. ${PASTE_HINT}`)
    }
    return paramsForJob(job, item.options)
  }

  private fail(item: QueueItem, error: string): void {
    item.status = 'failed'
    item.error = error
    item.updatedAt = new Date(this.now()).toISOString()
    this.save()
    this.deps.onChange(this.state())
  }
}
