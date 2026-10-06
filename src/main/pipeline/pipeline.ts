import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canFetchDetails, type Job } from '@shared/jobs-types'
import {
  BATTERY_WARNING,
  DEFAULT_STALL_MINUTES,
  FALLBACK_JOB_MINUTES,
  KEEP_AWAKE_MAX_WAIT_MS,
  MIN_FREE_DISK_BYTES,
  type PipelineBudget,
  type PipelineCounts,
  type PipelineLimit,
  type PipelinePlan,
  type PipelineRecord,
  type PipelineSkip,
  type PipelineStartInput,
  type PipelineState,
  type PipelineSummary
} from '@shared/pipeline-types'
import type { QueueItem, QueueItemOutcome } from '@shared/queue-types'
import { REVIEW_NOTES_FILE } from '@shared/review-types'
import { AGENT_LABEL, type AgentId, type RunSummary } from '@shared/runner-types'
import { summarizeBuild } from '../applications/scan'
import { getReview, updateReview, type RecordedReview } from '../review/authority'
import { folderSlug, newRunId } from '../cli/runs'
import { PASTE_HINT, type FailureDecision, type Settlement, type TailorQueue } from '../queue/queue'
import { HUNTGRY_DIR } from '../workspace/constants'
import {
  backoffDelay,
  classifyFailure,
  LIMIT_MARGIN_MS,
  MAX_RETRIES,
  STALL_PREFIX,
  unparsedLimitWait,
  type Failure
} from './failures'
import type { NotificationCategory } from './notify'

/**
 * The unattended pipeline (#31): policy over the queue's unattended items.
 * One record at a time, persisted in `queue.json` by the queue. Electron-free;
 * `pipeline/ipc.ts` injects the app's queue, run manager, power, notification
 * and environment functions, tests inject fakes and a clock.
 *
 * - Pre-flight (`plan`): agent, fallback, shared dependencies, disk, then per
 *   job: saved, not dismissed, not queued, not tailored before, full posting.
 * - `beforeLaunch`: holds the pipeline's items while paused, stopped on the
 *   budget, waiting for an agent's limit, or right after a run reported a
 *   rejected rate limit.
 * - `settle`: the verify gate on an ended turn (built + verified + notes →
 *   Unreviewed, else Needs attention), one nudge when the agent stopped
 *   without building, then needs-reply.
 * - `onFailure`: usage limit → wait until the parsed reset (+ 2 min) or switch
 *   the remaining jobs to the fallback agent; transient, burst and stall →
 *   backoff 30 s / 120 s, at most twice; permanent → failed.
 * - A 60 s tick runs the stall watchdog, clears passed limits and keeps the
 *   Mac awake while there is work.
 */

export interface PipelineDeps {
  queue: TailorQueue
  workspace(): Promise<string>
  findJob(workspace: string, id: string): Promise<Job | null>
  fetchDetails(workspace: string, id: string): Promise<Job>
  /** Job-id slugs of the application folders already in the workspace (skip jobs tailored before). */
  tailoredJobIds(workspace: string): Promise<Set<string>>
  /** Readiness of every agent (CLI, version, sign-in, skill) and the shared dependency problems. */
  environment(): Promise<{ agents: { id: AgentId; ready: boolean; problems: string[] }[]; sharedProblems: string[] }>
  freeDiskBytes(workspace: string): Promise<number | null>
  runHistory(workspace: string): Promise<{ medianMs: number | null; medianCostUsd: number | null }>
  /** Runs the skill's verify.py on a built resume that has no build report. */
  verify(workspace: string, folder: string): Promise<{ ok: boolean; report: string }>
  liveRun(runId: string): RunSummary | null
  /** Kills a stalled run; it ends `failed` with `reason`. */
  abort(runId: string, reason: string): void
  notify(category: NotificationCategory, title: string, body: string): void
  setBadge(count: number): void
  keepAwake(on: boolean): void
  onBattery(): boolean
  emit(state: PipelineState | null): void
  emitFinished(summary: PipelineSummary): void
  now?(): number
  /** Watchdog and limit tick; 60 s by default. */
  tickMs?: number
  random?(): number
  /** First retry of a first-turn burst limit (#21's 15 s). */
  burstRetryMs?: number
}

export const SUMMARY_FILE = 'pipeline-summary.json'
export const NUDGE_TEXT =
  'Nobody can answer. Apply the unattended approval rule from your instructions (use only master-profile facts and the standing approvals, leave everything else out and list it in review-notes.md) and continue to the build now, in this turn.'
const STALL_TEXT = (minutes: number) => `${STALL_PREFIX} ${minutes} minutes.`
/** A rejected rate-limit event holds new launches this long while the failure itself is classified. */
const REJECTED_HOLD_MS = 10 * 60_000
const ACTIVE = new Set<QueueItem['status']>(['queued', 'preparing', 'running'])
/** Summary outcomes that are review states (the others are where the run ended). */
const REVIEW_OUTCOMES = new Set<string>(['unreviewed', 'needs-attention', 'approved', 'discarded'])
export const IN_PROGRESS_REASON = 'Still being tailored unattended; not checked yet.'

/**
 * The run's output folder when it is this job's: `<role>/<company>/<job-id>` with the job id the
 * agent was told to use. (A folder another run wrote seconds earlier is never taken for this one.)
 */
function ownFolder(run: RunSummary): string | null {
  const folder = run.outputFolder
  if (!folder) return null
  const wanted = run.params.jobId ? folderSlug(run.params.jobId) : null
  return !wanted || folderSlug(folder.split('/')[2] ?? '') === wanted ? folder : null
}

export const summaryFile = (workspace: string): string => join(workspace, HUNTGRY_DIR, SUMMARY_FILE)

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export class Pipeline {
  private record: PipelineRecord | null = null
  private timer: NodeJS.Timeout | null = null
  private rejected: { agent: AgentId; at: number } | null = null
  private utilization: number | undefined
  private awake = false
  private lastEmitted = ''
  private lastSaved = ''
  private notifiedLimit: string | null = null
  private stopped = false
  private starting = false
  /** Runs whose output folder was marked Unreviewed while they work, and the pending writes. */
  private marking = new Map<string, Promise<void>>()
  /** What the dock badge shows (nothing when the app starts). */
  private badge = 0
  /** The running review sync and whether another one was asked for meanwhile. */
  private syncing: Promise<void> | null = null
  private syncAgain = false

  constructor(private deps: PipelineDeps) {
    deps.queue.setUnattendedHooks({
      beforeLaunch: (item, dryRun) => this.beforeLaunch(item, dryRun),
      settle: (item, run, ws) => this.settle(item, run, ws),
      onFailure: (item, run) => this.onFailure(item, run),
      onStartError: (item, error) => this.onStartError(item, error),
      onChange: () => this.changed(),
      onLoad: (record) => this.onLoad(record)
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * After the app is ready: loads the queue (and the pipeline record in it) and, when the
   * pipeline was running and asked to resume after a restart, starts pumping after a grace period.
   */
  async init(graceMs = 5000): Promise<void> {
    await this.deps.queue.sync()
    // Items saved before #72 (or by a decision made while the app was closed) may carry an old state.
    await this.syncReviews()
    const r = this.record
    if (!r) return
    if (r.status === 'running' || r.status === 'waiting-limit') {
      if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
      if (this.record !== r || this.stopped) return
      this.reconcile()
      this.deps.queue.kick()
    }
    this.changed()
  }

  private onLoad(record: PipelineRecord | null): void {
    this.record = record
    this.rejected = null
    this.utilization = undefined
    this.notifiedLimit = null
    this.lastEmitted = ''
    this.lastSaved = record ? JSON.stringify(record) : ''
    this.marking.clear()
    this.ensureTimer()
    this.changed()
  }

  /** Before quit: release the keep-awake and stop ticking (the queue saves itself). */
  async shutdown(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.awake) {
      this.awake = false
      this.deps.keepAwake(false)
    }
  }

  /** The Mac woke up: limits may have passed and deferred items may be due. */
  wake(): void {
    this.rejected = null
    this.reconcile()
    this.deps.queue.kick()
    this.changed()
  }

  /** Plugged in or unplugged: the panel's warning changes. */
  powerChanged(): void {
    this.changed()
  }

  /** Every run summary (the app wires `onRunChange` here): cost, proactive rate-limit hold, utilisation. */
  onRun(run: RunSummary): void {
    this.markInProgress(run)
    const r = this.record
    if (!r) return
    const item = this.deps.queue.itemsOf(r.id).find((i) => i.runId === run.id)
    if (!item) return
    let touched = false
    if (run.costUsd > 0 && r.runCosts[run.id] !== run.costUsd) {
      r.runCosts[run.id] = run.costUsd
      touched = true
    }
    if (run.rateLimit?.status === 'rejected') this.rejected = { agent: item.agent, at: this.now() }
    if (run.rateLimit?.status === 'allowed_warning' && run.rateLimit.utilization !== undefined)
      this.utilization = run.rateLimit.utilization
    if (touched) this.persist()
    this.changed()
  }

  // ---------------------------------------------------------------- API

  async plan(input: Required<Omit<PipelineStartInput, 'fallbackAgent' | 'budget'>> & { fallbackAgent?: AgentId; budget?: PipelineBudget }): Promise<PipelinePlan> {
    const ws = await this.deps.workspace()
    const blockers: string[] = []
    const warnings: string[] = []
    const env = await this.deps.environment()
    const agentProblems = (id: AgentId, prefix: string) => {
      const a = env.agents.find((x) => x.id === id)
      if (!a) blockers.push(`${prefix}${AGENT_LABEL[id]} is unknown.`)
      else if (!a.ready) for (const p of a.problems) blockers.push(`${prefix}${p}`)
    }
    agentProblems(input.agent, '')
    if (input.fallbackAgent) agentProblems(input.fallbackAgent, `Fallback ${AGENT_LABEL[input.fallbackAgent]}: `)
    blockers.push(...env.sharedProblems)
    const free = await this.deps.freeDiskBytes(ws)
    if (free !== null && free < MIN_FREE_DISK_BYTES)
      blockers.push(`Only ${Math.round(free / 1024 / 1024)} MB are free on the workspace disk; ${Math.round(MIN_FREE_DISK_BYTES / 1024 / 1024)} MB are needed.`)
    if (this.record && this.record.status !== 'finished')
      blockers.push('A pipeline is already running. Stop it, or wait for it to finish.')

    const state = await this.deps.queue.sync()
    const queued = new Set(state.items.filter((i) => ACTIVE.has(i.status) || i.status === 'needs-reply').map((i) => i.jobId))
    const tailored = input.skipTailored ? await this.deps.tailoredJobIds(ws) : new Set<string>()
    const ready: PipelinePlan['ready'] = []
    const skipped: PipelineSkip[] = []
    const toFetch: Job[] = []
    const titleOf = (job: Job) => [job.title, job.company].filter(Boolean).join(' · ')
    for (const id of input.jobIds) {
      const job = await this.deps.findJob(ws, id)
      if (!job) {
        skipped.push({ jobId: id, title: id, reason: 'This job is no longer saved.' })
        continue
      }
      const title = titleOf(job)
      if (job.dismissed) skipped.push({ jobId: job.id, title, reason: 'Dismissed jobs are not tailored.' })
      else if (queued.has(job.id)) skipped.push({ jobId: job.id, title, reason: 'Already in the queue.' })
      else if (tailored.has(folderSlug(job.sourceId)))
        skipped.push({ jobId: job.id, title, reason: 'Tailored before (untick "Skip jobs tailored before" to include it).' })
      else if (job.descriptionComplete) ready.push({ jobId: job.id, title })
      else if (!canFetchDetails(job))
        skipped.push({ jobId: job.id, title, reason: `Indeed shows full job descriptions only after a human check. ${PASTE_HINT}` })
      else toFetch.push(job)
    }
    // The full postings are fetched up front, three at a time, so nothing waits for a page at 3 am.
    for (let i = 0; i < toFetch.length; i += 3) {
      await Promise.all(
        toFetch.slice(i, i + 3).map(async (job) => {
          const title = titleOf(job)
          try {
            const full = await this.deps.fetchDetails(ws, job.id)
            if (full.descriptionComplete) ready.push({ jobId: job.id, title })
            else skipped.push({ jobId: job.id, title, reason: `Only part of the posting could be read. ${PASTE_HINT}` })
          } catch (err) {
            const reason = (err instanceof Error ? err.message : String(err)).replace(/\s*The summary from the job board is kept;.*$/, '')
            skipped.push({ jobId: job.id, title, reason: `${reason} ${PASTE_HINT}` })
          }
        })
      )
    }
    // Keep the user's order.
    const order = new Map(input.jobIds.map((id, i) => [id, i]))
    ready.sort((a, b) => (order.get(a.jobId) ?? 0) - (order.get(b.jobId) ?? 0))
    skipped.sort((a, b) => (order.get(a.jobId) ?? 0) - (order.get(b.jobId) ?? 0))

    const history = await this.deps.runHistory(ws)
    const msPerJob = history.medianMs ?? FALLBACK_JOB_MINUTES * 60_000
    const estimateMinutes = ready.length ? Math.ceil((msPerJob * ready.length) / input.concurrency / 60_000) : 0
    const estimateCostUsd =
      input.agent === 'claude' && history.medianCostUsd !== null && ready.length
        ? Math.round(history.medianCostUsd * ready.length * 100) / 100
        : null
    const onBattery = this.deps.onBattery()
    if (onBattery) warnings.push(BATTERY_WARNING)
    if (input.budget?.maxCostUsd !== undefined && input.agent !== 'claude')
      warnings.push(`The cost cap counts Claude runs only; ${AGENT_LABEL[input.agent]} reports tokens, not dollars.`)
    if (history.medianMs === null && ready.length)
      warnings.push(`No unattended runs yet: the estimate assumes ${FALLBACK_JOB_MINUTES} minutes per job.`)
    return {
      agent: input.agent,
      fallbackAgent: input.fallbackAgent,
      concurrency: input.concurrency,
      ready,
      skipped,
      blockers,
      warnings,
      estimateMinutes,
      estimateCostUsd,
      onBattery
    }
  }

  /**
   * One start at a time: the check that no pipeline is active and the record that makes one
   * active are separated by awaits (plan, history), so a second start (a double click, the phone)
   * is refused while the first is between them.
   */
  async start(input: Parameters<Pipeline['plan']>[0]): Promise<PipelineState> {
    if (this.starting) throw new Error('A pipeline is already starting.')
    this.starting = true
    try {
      return await this.startNow(input)
    } finally {
      this.starting = false
    }
  }

  private async startNow(input: Parameters<Pipeline['plan']>[0]): Promise<PipelineState> {
    const plan = await this.plan(input)
    if (plan.blockers.length > 0) throw new Error(plan.blockers[0])
    if (plan.ready.length === 0)
      throw new Error(`No job can run unattended. ${plan.skipped[0]?.reason ?? 'Select at least one saved job.'}`)
    const ws = await this.deps.workspace()
    const history = await this.deps.runHistory(ws)
    const now = this.now()
    const record: PipelineRecord = {
      id: `p-${newRunId(new Date(now))}`,
      status: 'running',
      options: {
        ...input.options,
        agent: input.agent,
        ...(input.fallbackAgent ? { fallbackAgent: input.fallbackAgent } : {}),
        concurrency: input.concurrency,
        ...(input.budget ? { budget: input.budget } : {}),
        resumeAfterRestart: input.resumeAfterRestart,
        skipTailored: input.skipTailored,
        stallMinutes: input.stallMinutes
      },
      itemIds: [],
      skipped: plan.skipped,
      limits: {},
      unparsedStrikes: 0,
      startedAt: new Date(now).toISOString(),
      runCosts: {},
      estimateMsPerJob: history.medianMs
    }
    this.record = record
    this.rejected = null
    this.utilization = undefined
    this.notifiedLimit = null
    this.deps.queue.savePipeline(record)
    const res = await this.deps.queue.enqueue({
      jobIds: plan.ready.map((j) => j.jobId),
      options: input.options,
      concurrency: input.concurrency,
      agent: input.agent,
      unattended: true,
      pipelineId: record.id
    })
    record.itemIds = res.state.items.filter((i) => i.pipelineId === record.id).map((i) => i.id)
    for (const s of res.skipped) {
      const title = plan.ready.find((j) => j.jobId === s.jobId)?.title ?? s.jobId
      record.skipped.push({ jobId: s.jobId, title, reason: s.reason })
    }
    this.persist()
    this.ensureTimer()
    this.reconcile()
    this.changed()
    return this.state()!
  }

  async pause(): Promise<PipelineState> {
    const r = this.require()
    if (r.status === 'running' || r.status === 'waiting-limit') {
      r.status = 'paused'
      r.stopReason = undefined
      this.persist()
    }
    this.reconcile()
    this.changed()
    return this.state()!
  }

  async resume(options: { budget?: PipelineBudget } = {}): Promise<PipelineState> {
    const r = this.require()
    if (options.budget) r.options.budget = options.budget
    if (r.status === 'paused' || r.status === 'stopped-budget') {
      r.status = 'running'
      r.stopReason = undefined
      r.interruptedAt = undefined
    }
    this.persist()
    // The queue itself may be paused (a restart without resume-after-restart, or a start error).
    if (this.deps.queue.isPaused()) await this.deps.queue.setPaused(false)
    this.reconcile()
    this.deps.queue.kick()
    this.changed()
    return this.state()!
  }

  async stop(): Promise<PipelineState> {
    const r = this.require()
    if (r.status !== 'finished') {
      r.status = 'stopping'
      r.stopReason = 'Stopped by you.'
      this.persist()
      this.deps.queue.cancelPipeline(r.id)
    }
    this.reconcile()
    this.changed()
    return this.state()!
  }

  state(): PipelineState | null {
    const r = this.record
    if (!r) return null
    const items = this.deps.queue.itemsOf(r.id)
    const counts = this.counts(r, items)
    const now = this.now()
    const remaining = counts.queued + counts.running
    const msPerJob = r.estimateMsPerJob ?? FALLBACK_JOB_MINUTES * 60_000
    const limit = this.blockingLimit(r, items)
    const warnings: string[] = []
    if (this.deps.onBattery()) warnings.push(BATTERY_WARNING)
    if (r.interruptedAt && r.status !== 'finished')
      warnings.push(
        r.options.resumeAfterRestart
          ? 'Huntgry restarted while this pipeline was running; interrupted jobs were queued again.'
          : 'Pipeline interrupted by a restart. Press Resume to continue.'
      )
    if (r.options.budget?.maxCostUsd !== undefined && r.options.agent !== 'claude')
      warnings.push('The cost cap counts Claude runs only.')
    return {
      id: r.id,
      status: r.status,
      until: limit?.until,
      limitAgent: limit?.agent,
      limitMessage: limit?.message,
      fallbackActive: this.fallbackActive(r, items),
      counts,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      etaMinutes:
        r.status === 'finished'
          ? null
          : Math.max(
              0,
              Math.ceil(((remaining * msPerJob) / r.options.concurrency + (limit ? Math.max(0, Date.parse(limit.until) - now) : 0)) / 60_000)
            ),
      costUsd: this.costUsd(r),
      budget: r.options.budget,
      startedJobs: items.filter((i) => i.startedAt).length,
      onBattery: this.deps.onBattery(),
      keepAwake: this.awake,
      warnings,
      utilization: this.utilization,
      interrupted: !!r.interruptedAt,
      stopReason: r.stopReason,
      agent: r.options.agent,
      fallbackAgent: r.options.fallbackAgent,
      concurrency: r.options.concurrency
    }
  }

  /**
   * The last finished pipeline's summary, with each result's review state read live from the
   * review store (#72): what was approved or discarded since it finished no longer counts as
   * ready for review. The file itself is written once, when the pipeline finishes.
   */
  async lastSummary(): Promise<PipelineSummary | null> {
    const ws = await this.deps.workspace()
    let summary: PipelineSummary
    try {
      summary = JSON.parse(await readFile(summaryFile(ws), 'utf8')) as PipelineSummary
    } catch {
      return null
    }
    if (!Array.isArray(summary.items) || typeof summary.counts !== 'object' || summary.counts === null) return summary
    const items = await Promise.all(
      summary.items.map(async (i) => {
        if (!i.applicationId || !REVIEW_OUTCOMES.has(i.outcome)) return i
        const review = await getReview(ws, i.applicationId).catch(() => undefined)
        return review ? { ...i, outcome: review.state } : i
      })
    )
    const counts = { ...summary.counts, unreviewed: 0, needsAttention: 0, approved: 0, discarded: 0 }
    for (const i of items) {
      if (i.outcome === 'unreviewed') counts.unreviewed++
      else if (i.outcome === 'needs-attention') counts.needsAttention++
      else if (i.outcome === 'approved') counts.approved++
      else if (i.outcome === 'discarded') counts.discarded++
    }
    return { ...summary, items, counts }
  }

  /**
   * Brings the done unattended items of the whole queue (every pipeline's) in step with the
   * review store after a decision (#72): Approve, Discard and Re-run write only the store, so the
   * Tailor page, the counts and the dock badge would keep saying "Unreviewed". The queue
   * broadcasts when an item changed, and the pipeline state follows. Calls made while one runs
   * are folded into one more pass.
   */
  syncReviews(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true
      return this.syncing
    }
    const run = async (): Promise<void> => {
      do {
        this.syncAgain = false
        await this.syncOnce()
      } while (this.syncAgain && !this.stopped)
    }
    this.syncing = run().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async syncOnce(): Promise<void> {
    const ws = this.deps.queue.workspace()
    if (!ws || this.stopped) return
    const done = this.deps.queue.state().items.filter((i) => i.status === 'done' && i.unattended && i.applicationId && i.runId)
    const reviews: { applicationId: string; runId: string; state: QueueItemOutcome }[] = []
    for (const i of done) {
      const review = await getReview(ws, i.applicationId!).catch(() => undefined)
      if (review) reviews.push({ applicationId: i.applicationId!, runId: review.runId, state: review.state })
    }
    // The queue's runId check keeps an older run's decision off a newer result of the same folder.
    this.deps.queue.setOutcomes(ws, reviews)
    this.updateBadge()
  }

  /** The dock badge: done unattended results anywhere in the queue still waiting for review. */
  private updateBadge(force = false): void {
    const n = this.deps.queue
      .state()
      .items.filter((i) => i.status === 'done' && i.unattended && (i.outcome === undefined || i.outcome === 'unreviewed' || i.outcome === 'needs-attention')).length
    if (n === this.badge && !force) return
    this.badge = n
    this.deps.setBadge(n)
  }

  async dismiss(): Promise<void> {
    if (this.record && this.record.status !== 'finished') throw new Error('Stop the pipeline first.')
    this.record = null
    this.deps.queue.savePipeline(null)
    this.lastSaved = ''
    this.changed()
  }

  // ---------------------------------------------------------------- hooks (queue policy)

  private beforeLaunch(item: QueueItem, dryRun = false): 'go' | 'hold' {
    const r = this.record
    if (!r || item.pipelineId !== r.id) return 'go'
    // A finished pipeline whose job gets work again (Retry, a re-run, a Tailor reply) is supervised again.
    if (r.status === 'finished' && !dryRun) this.reopen(r)
    if (r.status === 'paused' || r.status === 'stopping') return 'hold'
    if (this.budgetReached(r, item)) {
      if (r.status !== 'stopped-budget' && !dryRun) {
        r.status = 'stopped-budget'
        r.stopReason = this.budgetReason(r)
        this.persist()
        this.deps.notify('budget', 'Huntgry pipeline stopped', r.stopReason)
        this.updateAwake()
        this.changed()
      }
      return 'hold'
    }
    // Stopped on the budget, this launch still fits it: the retry of a job that already started.
    const now = this.now()
    const limit = r.limits[item.agent]
    if (limit && Date.parse(limit.until) > now) return 'hold'
    if (this.rejected && this.rejected.agent === item.agent && now - this.rejected.at < REJECTED_HOLD_MS) return 'hold'
    return 'go'
  }

  /**
   * Marks an unattended run's folder Unreviewed as soon as the run records it: the resume may be
   * built minutes before the turn ends, and a stop, a crash or a failed retry may come first.
   * Apply must never see an unattended result without a review state. A folder already marked
   * for this run (a re-run from the Review page, or the settled result) is left as it is.
   */
  private markInProgress(run: RunSummary): void {
    if (!run.unattended || this.marking.has(run.id)) return
    const folder = ownFolder(run)
    const ws = this.deps.queue.workspace()
    if (!folder || !ws) return
    const at = new Date(this.now()).toISOString()
    this.marking.set(
      run.id,
      updateReview(ws, folder, (current) =>
        current?.runId === run.id ? null : { state: 'unreviewed', runId: run.id, at, reason: IN_PROGRESS_REASON }
      )
        .then(() => undefined)
        .catch((err) => console.error('Marking the unattended result Unreviewed failed:', err))
    )
  }

  /** The verify gate: what an ended unattended turn means. */
  private async settle(item: QueueItem, run: RunSummary, ws: string): Promise<Settlement> {
    const folder = ownFolder(run)
    const built = folder !== null && run.outputFiles.includes('resume.pdf')
    if (!built) {
      if (!item.nudged) return { kind: 'nudge', text: NUDGE_TEXT }
      const error = 'Stopped with a question instead of building. Answer it on the Tailor page.'
      // Whatever it left in its folder (notes, a draft) needs a look, not Apply.
      if (folder) {
        await this.marking.get(run.id)
        await this.record_(ws, folder, { state: 'needs-attention', runId: run.id, at: new Date(this.now()).toISOString(), reason: error })
      }
      return { kind: 'needs-reply', error }
    }
    const dir = join(ws, folder)
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      // The folder vanished: nothing to record.
    }
    const reasons: string[] = []
    let ok: boolean
    let verify: RecordedReview['verify']
    if (files.includes('build-report.json')) {
      const report = summarizeBuild(await readFile(join(dir, 'build-report.json'), 'utf8').catch(() => null))
      ok = report.status === 'pass'
      if (report.status === 'fail') reasons.push(`Failed checks: ${report.failed.join(', ') || 'see build-report.json'}.`)
      else if (report.status === 'unknown') reasons.push('build-report.json is unreadable.')
    } else {
      const v = await this.deps.verify(ws, folder)
      ok = v.ok
      // Kept with the review state (main-owned), so the Review page shows the checks verify.py ran.
      verify = { ok: v.ok, report: v.report.slice(0, 8000) }
      if (!ok) reasons.push(`No build report and verify.py did not pass: ${v.report.split('\n')[0]}`)
    }
    if (!files.includes(REVIEW_NOTES_FILE)) reasons.push('No review notes (review-notes.md) were written.')
    // Built, then the turn failed (an error result, a crash, the stall watchdog): what is on disk is
    // recorded, not rebuilt, but it needs a look.
    if (run.error) reasons.push(`The last turn ended with an error: ${run.error.split('\n')[0]}`)
    const state = ok && reasons.length === 0 ? 'unreviewed' : 'needs-attention'
    const reason = reasons.join(' ') || undefined
    const review: RecordedReview = { state, runId: run.id, at: new Date(this.now()).toISOString() }
    if (reason) review.reason = reason
    if (verify) review.verify = verify
    // After the in-progress mark, never before it (it would overwrite the settled state).
    await this.marking.get(run.id)
    // What the store kept: a Discard made while the gate ran stays Discarded on the Tailor page too (#72).
    const outcome = await this.record_(ws, folder, review)
    return { kind: 'done', outcome, applicationId: folder, reason }
  }

  /**
   * Records a verify-gate result in main's review store. The user's Discard of this run's result
   * is terminal: the gate never turns it back into something that can be approved and applied.
   */
  private async record_(ws: string, folder: string, review: RecordedReview): Promise<QueueItemOutcome> {
    const { review: recorded } = await updateReview(ws, folder, (current) => {
      if (current?.state !== 'discarded' || current.runId !== review.runId) return review
      // Still discarded; only what verify.py said is added, for the record.
      return review.verify ? { ...current, verify: review.verify } : null
    })
    return recorded?.state ?? review.state
  }

  private onFailure(item: QueueItem, run: RunSummary): FailureDecision {
    const r = this.record
    const f = classifyFailure({ agent: item.agent, error: run.error, rateLimit: run.rateLimit }, this.now())
    const retries = item.retries ?? 0
    const label = AGENT_LABEL[item.agent]
    switch (f.kind) {
      case 'usage-limit':
        return this.onLimit(item, f)
      case 'spend-limit':
        if (r && item.pipelineId === r.id) {
          r.status = 'paused'
          r.stopReason = `${label} reached its spend limit: ${f.message}`
          this.persist()
          this.deps.notify('failed', 'Huntgry pipeline paused', r.stopReason)
          this.updateAwake()
        }
        return { action: 'requeue', delayMs: 0, countRetry: false, error: `${label} reached its spend limit; raise it, then Resume. (${f.message})`, kind: f.kind }
      case 'burst-limit':
        if (item.attempts === 0)
          return {
            action: 'requeue',
            delayMs: this.deps.burstRetryMs ?? 15_000,
            countRetry: false,
            error: `${label}'s servers limited new sessions; retrying automatically. (${f.message})`,
            kind: f.kind
          }
      // falls through
      case 'transient':
      case 'stall':
        if (retries < MAX_RETRIES) {
          const delay = backoffDelay(retries, this.deps.random)
          return {
            action: 'requeue',
            delayMs: delay,
            countRetry: true,
            error: `${f.kind === 'stall' ? 'No output from the agent' : 'Temporary failure'}; retrying in ${Math.round(delay / 1000)} s (${retries + 1} of ${MAX_RETRIES}). (${f.message})`,
            kind: f.kind
          }
        }
        return { action: 'fail', error: `Failed ${MAX_RETRIES + 1} times; last error: ${run.error ?? f.message}`, kind: f.kind }
      case 'permanent':
        return { action: 'fail', error: run.error ?? f.message, kind: f.kind }
    }
  }

  private onLimit(item: QueueItem, f: Failure): FailureDecision {
    const r = this.record
    const now = this.now()
    const label = AGENT_LABEL[item.agent]
    if (!r || item.pipelineId !== r.id) {
      const until = f.parsed && f.resetAt ? f.resetAt + LIMIT_MARGIN_MS : now + unparsedLimitWait(0)
      return { action: 'requeue', delayMs: until - now, countRetry: false, error: `${label} hit its usage limit; trying again at ${clockTime(until)}. (${f.message})`, kind: f.kind }
    }
    const until = f.parsed && f.resetAt ? f.resetAt + LIMIT_MARGIN_MS : now + unparsedLimitWait(r.unparsedStrikes++)
    const limit: PipelineLimit = {
      agent: item.agent,
      until: new Date(until).toISOString(),
      kind: 'usage-limit',
      message: f.message,
      parsed: f.parsed === true
    }
    r.limits[item.agent] = limit
    this.rejected = null
    const alt = r.options.fallbackAgent
    // The fallback takes the jobs that have not started; this one keeps its agent, session and
    // partial work, and waits for the reset like without a fallback.
    const fallback = !!alt && alt !== item.agent && !this.limitActive(r, alt, now)
    const switched = fallback ? this.deps.queue.switchAgent(r.id, item.agent, alt) : 0
    this.persist()
    // With a usable fallback the pipeline goes on: no "paused" notification.
    if (!fallback && this.notifiedLimit !== limit.until) {
      this.notifiedLimit = limit.until
      this.deps.notify(
        'usage-limit',
        `Huntgry pipeline paused until ${clockTime(until)}`,
        `${label} hit its usage limit${f.parsed ? '' : ' (reset time unknown)'}; the pipeline resumes by itself.`
      )
    }
    this.updateAwake()
    return {
      action: 'requeue',
      delayMs: until - now,
      notBefore: limit.until,
      countRetry: false,
      error: `Waiting for ${label}'s limit to reset; trying again at ${clockTime(until)}${switched ? ` (${switched} other job${switched === 1 ? '' : 's'} moved to ${AGENT_LABEL[alt!]})` : ''}. (${f.message})`,
      kind: f.kind
    }
  }

  private onStartError(item: QueueItem, error: string): void {
    const r = this.record
    if (!r || item.pipelineId !== r.id) return
    r.status = 'paused'
    r.stopReason = `Cannot start ${AGENT_LABEL[item.agent]}: ${error}`
    this.persist()
    this.deps.notify('failed', 'Huntgry pipeline paused', r.stopReason)
    this.updateAwake()
    this.changed()
  }

  // ---------------------------------------------------------------- internals

  private require(): PipelineRecord {
    if (!this.record) throw new Error('No pipeline is running.')
    return this.record
  }

  private ensureTimer(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 60_000)
    this.timer.unref?.()
  }

  /** Unattended items with an agent at work: this pipeline's and any other (an older pipeline's, a re-run). */
  private workingUnattended(): QueueItem[] {
    return this.deps.queue.state().items.filter((i) => i.unattended && (i.status === 'preparing' || i.status === 'running'))
  }

  /** Watchdog (every unattended run, pipeline finished or not), passed limits, keep-awake. */
  private tick(): void {
    const r = this.record
    const now = this.now()
    const stallMinutes = r?.options.stallMinutes ?? DEFAULT_STALL_MINUTES
    for (const item of this.workingUnattended()) {
      if (item.status !== 'running' || !item.runId) continue
      const live = this.deps.liveRun(item.runId)
      if (live?.lastOutputAt && now - Date.parse(live.lastOutputAt) > stallMinutes * 60_000) {
        this.deps.abort(item.runId, STALL_TEXT(stallMinutes))
      }
    }
    if (!r || r.status === 'finished') {
      this.updateAwake()
      return
    }
    const before = JSON.stringify(r.limits)
    this.reconcile()
    if (JSON.stringify(r.limits) !== before || (this.rejected && now - this.rejected.at >= REJECTED_HOLD_MS)) {
      this.rejected = null
      this.deps.queue.kick()
    }
    this.changed()
  }

  private limitActive(r: PipelineRecord, agent: AgentId, now: number): boolean {
    const l = r.limits[agent]
    return !!l && Date.parse(l.until) > now
  }

  /** The limit the remaining jobs wait for (the earliest among their agents), if any. */
  private blockingLimit(r: PipelineRecord, items: QueueItem[]): PipelineLimit | undefined {
    const now = this.now()
    const agents = new Set(items.filter((i) => i.status === 'queued').map((i) => i.agent))
    if (agents.size === 0) agents.add(r.options.agent)
    const active = [...agents].map((a) => r.limits[a]).filter((l): l is PipelineLimit => !!l && Date.parse(l.until) > now)
    return active.sort((a, b) => a.until.localeCompare(b.until))[0]
  }

  private fallbackActive(r: PipelineRecord, items: QueueItem[]): boolean {
    const alt = r.options.fallbackAgent
    return !!alt && items.some((i) => i.agent === alt && ACTIVE.has(i.status))
  }

  private costUsd(r: PipelineRecord): number {
    return Math.round(Object.values(r.runCosts).reduce((a, b) => a + b, 0) * 100) / 100
  }

  /**
   * Whether launching `item` would exceed the budget. The job cap counts jobs, so a retry of a
   * job that already started (backoff, a limit, a restart) is not a new job; the cost cap holds
   * every launch, since a retry costs money too.
   */
  private budgetReached(r: PipelineRecord, item: QueueItem): boolean {
    const b = r.options.budget
    if (!b) return false
    const started = this.deps.queue.itemsOf(r.id).filter((i) => i.startedAt).length
    return (
      (b.maxJobs !== undefined && !item.startedAt && started >= b.maxJobs) ||
      (b.maxCostUsd !== undefined && this.costUsd(r) >= b.maxCostUsd)
    )
  }

  private budgetReason(r: PipelineRecord): string {
    const b = r.options.budget ?? {}
    const started = this.deps.queue.itemsOf(r.id).filter((i) => i.startedAt).length
    if (b.maxJobs !== undefined && started >= b.maxJobs) return `Budget reached: ${started} of ${b.maxJobs} jobs started. Raise it and Resume to continue.`
    return `Budget reached: $${this.costUsd(r).toFixed(2)} of $${b.maxCostUsd?.toFixed(2)} spent. Raise it and Resume to continue.`
  }

  private counts(r: PipelineRecord, items: QueueItem[]): PipelineCounts {
    const c: PipelineCounts = {
      queued: 0,
      running: 0,
      needsReply: 0,
      unreviewed: 0,
      needsAttention: 0,
      approved: 0,
      discarded: 0,
      failed: 0,
      cancelled: 0,
      skipped: r.skipped.length,
      total: items.length + r.skipped.length
    }
    for (const i of items) {
      if (i.status === 'queued') c.queued++
      else if (i.status === 'preparing' || i.status === 'running') c.running++
      else if (i.status === 'needs-reply') c.needsReply++
      else if (i.status === 'done') {
        if (i.outcome === 'needs-attention') c.needsAttention++
        else if (i.outcome === 'approved') c.approved++
        else if (i.outcome === 'discarded') c.discarded++
        else c.unreviewed++
      } else if (i.status === 'failed') c.failed++
      else if (i.status === 'cancelled') c.cancelled++
    }
    return c
  }

  /** A finished pipeline gets work again: running, supervised (watchdog, keep-awake, recovery), summary again at the end. */
  private reopen(r: PipelineRecord): void {
    if (r.status !== 'finished') return
    r.status = 'running'
    r.finishedAt = undefined
    r.stopReason = undefined
    this.persist()
    this.ensureTimer()
    this.updateAwake()
  }

  /** Clears passed limits, moves between running and waiting-limit, finishes when nothing is left. */
  private reconcile(): void {
    const r = this.record
    if (r?.status === 'finished' && this.deps.queue.itemsOf(r.id).some((i) => ACTIVE.has(i.status))) this.reopen(r)
    if (!r || r.status === 'finished') {
      this.updateAwake()
      return
    }
    const now = this.now()
    for (const agent of Object.keys(r.limits) as AgentId[]) {
      const l = r.limits[agent]
      if (l && Date.parse(l.until) <= now) delete r.limits[agent]
    }
    const items = this.deps.queue.itemsOf(r.id)
    if (r.status === 'running' || r.status === 'waiting-limit') {
      const queued = items.filter((i) => i.status === 'queued' && !i.pendingReply)
      const working = items.some((i) => i.status === 'preparing' || i.status === 'running')
      const blocked = queued.length > 0 && !working && queued.every((i) => this.limitActive(r, i.agent, now))
      r.status = blocked ? 'waiting-limit' : 'running'
    }
    const active = items.filter((i) => ACTIVE.has(i.status))
    if (items.length > 0 && active.length === 0) void this.finish(r, items)
    this.updateAwake()
    this.persist()
  }

  private async finish(r: PipelineRecord, items: QueueItem[]): Promise<void> {
    if (r.status === 'finished') return
    const now = this.now()
    r.status = 'finished'
    r.finishedAt = new Date(now).toISOString()
    const counts = this.counts(r, items)
    const summary: PipelineSummary = {
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      counts,
      costUsd: this.costUsd(r),
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      items: items.map((i) => ({
        jobId: i.jobId,
        title: i.title,
        outcome:
          i.status === 'done'
            ? (i.outcome ?? 'unreviewed')
            : i.status === 'needs-reply'
              ? 'needs-reply'
              : i.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
        ...(i.applicationId ? { applicationId: i.applicationId } : {}),
        ...(i.error ? { error: i.error } : {})
      })),
      skipped: r.skipped
    }
    this.persist()
    this.updateAwake()
    const ws = this.deps.queue.workspace()
    if (ws) await writeSummary(ws, summary).catch((err) => console.error('Writing the pipeline summary failed:', err))
    const look = counts.needsAttention + counts.needsReply + counts.failed
    this.deps.notify(
      'pipeline-finished',
      r.stopReason ? 'Huntgry pipeline stopped' : 'Huntgry pipeline finished',
      `${counts.unreviewed} ready for review · ${look} need a look · ${counts.cancelled} cancelled${summary.costUsd ? ` · $${summary.costUsd.toFixed(2)}` : ''}`
    )
    this.updateBadge(true)
    this.deps.emitFinished(summary)
    this.changed()
  }

  private updateAwake(): void {
    const r = this.record
    // Any unattended run at work keeps the Mac awake, in a finished, stopped or dismissed pipeline too.
    let on = this.workingUnattended().length > 0
    if (r && !on) {
      const limit = this.blockingLimit(r, this.deps.queue.itemsOf(r.id))
      const working = this.deps.queue.itemsOf(r.id).some((i) => i.status === 'preparing' || i.status === 'running')
      on =
        (r.status !== 'finished' && working) ||
        r.status === 'running' ||
        r.status === 'stopping' ||
        (r.status === 'waiting-limit' && (!limit || Date.parse(limit.until) - this.now() < KEEP_AWAKE_MAX_WAIT_MS))
    }
    if (on !== this.awake) {
      this.awake = on
      this.deps.keepAwake(on)
    }
  }

  private persist(): void {
    const r = this.record
    const json = r ? JSON.stringify(r) : ''
    if (json === this.lastSaved) return
    this.lastSaved = json
    this.deps.queue.savePipeline(r)
  }

  /** Recomputes and broadcasts the state when it changed. */
  private changed(): void {
    if (this.stopped) return
    if (this.workingUnattended().length > 0) this.ensureTimer()
    this.reconcile()
    const state = this.state()
    const json = JSON.stringify(state)
    if (json === this.lastEmitted) return
    this.lastEmitted = json
    this.deps.emit(state)
  }
}

async function writeSummary(workspace: string, summary: PipelineSummary): Promise<void> {
  const file = summaryFile(workspace)
  await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}
