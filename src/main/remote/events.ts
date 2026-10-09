import type { PipelineState as DesktopPipelineState, PipelineSummary as DesktopPipelineSummary } from '@shared/pipeline-types'
import type { QueueState } from '@shared/queue-types'
import type { RunSummary } from '@shared/runner-types'
import type { NotificationCategory, RemoteEventBody, RemoteEventName, ReviewItem, StatusSummary } from '@shared/remote'
import { categoryOf } from './gateway'
import { projectPipeline, projectPipelineSummary, projectQueue, projectRun, safeText } from './project'

/**
 * Desktop events → phone events (ADR-0001, "Events"): every window event the phone mirrors is
 * projected here, with the push hint it deserves. Electron-free: `ipc.ts` feeds it `onEvent`
 * and hands it the session's `broadcast`; tests feed it events and record what would be sent.
 *
 * Push hints follow what *changed*, not the body alone, so one situation is one push:
 * - a pipeline entering a usage-limit wait (once per reset time) → `usage-limit`;
 * - a pipeline paused by an error (spend limit, an agent that cannot start), or a job that
 *   failed for good → `failed`; a job that stopped with a question → `needs-reply`;
 * - a pipeline's summary → `pipeline-finished`;
 * - a result newly waiting for review (its run done with it) → `review.needed` / `needs-review`;
 * - an unattended run's own `run.changed` carries none: its pipeline reports it (a failed turn
 *   that is retried, or a turn that ended before the verify gate, is not news).
 */

export interface EventsDeps {
  /** The session's `broadcast` (dropped while offline). */
  broadcast<N extends RemoteEventName>(name: N, body: RemoteEventBody<N>, pushText?: string, hint?: NotificationCategory | null): Promise<void>
  /** The status of the open workspace (`statusOf`). */
  status(): Promise<StatusSummary>
  /** #42: the open workspace's listed results (`pendingReviews`); absent, no `review.needed`. */
  reviews?(): Promise<{ workspaceId: string; items: { item: ReviewItem; settled: boolean }[] }>
  /** Wait after a change before listing the results again (default 500 ms; bursts fold into one). */
  reviewDelayMs?: number
  now?(): number
}

interface PipelineSeen {
  id: string
  status: DesktopPipelineState['status']
  until?: string
  stopReason?: string
  failed: number
  needsReply: number
}

export class RemoteEvents {
  /** The last pipeline state seen; `undefined` until the first one (a restart does not push again). */
  private pipelineSeen: PipelineSeen | null | undefined
  /** `id:until` of the last limit wait pushed. */
  private limitPushed: string | null = null
  /** Per workspace: the settled results already announced (the first listing is the baseline). */
  private reviewSeen = new Map<string, Set<string>>()
  private reviewTimer: NodeJS.Timeout | null = null
  private reviewScan: Promise<void> = Promise.resolve()

  constructor(private deps: EventsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** One desktop event (`onEvent(channel, payload)`). Never rejects. */
  async handle(channel: string, payload: unknown): Promise<void> {
    try {
      if (channel === 'queue:changed' || channel === 'applications:changed' || channel === 'pipeline:finished') this.scheduleReviews()
      switch (channel) {
        case 'queue:changed':
          await this.deps.broadcast('queue.changed', projectQueue(payload as QueueState))
          await this.status()
          return
        case 'runner:run':
          return await this.run(payload as RunSummary)
        case 'applications:changed':
          return await this.deps.broadcast('applications.changed', { ids: [] })
        case 'pipeline:changed':
          return await this.pipeline(payload as DesktopPipelineState | null)
        case 'pipeline:finished':
          return await this.finished(payload as DesktopPipelineSummary)
      }
    } catch (err) {
      console.error(`[remote] forwarding ${channel} failed:`, err)
    }
  }

  private async status(): Promise<void> {
    const status = await this.deps.status().catch(() => null)
    if (status) await this.deps.broadcast('status', status)
  }

  private async run(run: RunSummary): Promise<void> {
    const body = projectRun(run)
    const unattended = run.unattended === true || run.params.unattended === true
    await this.deps.broadcast('run.changed', body, run.title, unattended ? null : categoryOf({ name: 'run.changed', body }))
  }

  private async pipeline(state: DesktopPipelineState | null): Promise<void> {
    const before = this.pipelineSeen
    if (!state) {
      this.pipelineSeen = null
      // Dismissed (or another workspace without one): the status says there is none.
      if (before !== null) await this.status()
      return
    }
    const { hint, pushText } = this.hintFor(before, state)
    this.pipelineSeen = { id: state.id, status: state.status, until: state.until, stopReason: state.stopReason, failed: state.counts.failed, needsReply: state.counts.needsReply }
    await this.deps.broadcast('pipeline.changed', projectPipeline(state, this.now()), pushText, hint)
    // The status carries the pipeline's status and limit time only: refresh it when those change.
    if (!before || before.id !== state.id || before.status !== state.status || before.until !== state.until) await this.status()
  }

  private hintFor(before: PipelineSeen | null | undefined, state: DesktopPipelineState): { hint: NotificationCategory | null; pushText?: string } {
    // The first state after start-up is the baseline: what was already so was already pushed.
    if (before === undefined) {
      if (state.status === 'waiting-limit' && state.until) this.limitPushed = `${state.id}:${state.until}`
      return { hint: null }
    }
    const prev = before && before.id === state.id ? before : { id: state.id, status: 'running' as const, failed: 0, needsReply: 0 }
    if (state.status === 'waiting-limit' && state.until) {
      const key = `${state.id}:${state.until}`
      if (this.limitPushed !== key) {
        this.limitPushed = key
        return { hint: 'usage-limit', pushText: state.limitMessage ? safeText(state.limitMessage) : undefined }
      }
    }
    if (state.status === 'paused' && state.stopReason && (prev.status !== 'paused' || prev.stopReason !== state.stopReason)) {
      return { hint: 'failed', pushText: safeText(state.stopReason) }
    }
    if (state.counts.failed > prev.failed) return { hint: 'failed' }
    if (state.counts.needsReply > prev.needsReply) return { hint: 'needs-reply' }
    return { hint: null }
  }

  private scheduleReviews(): void {
    if (!this.deps.reviews || this.reviewTimer) return
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = null
      void this.checkReviews()
    }, this.deps.reviewDelayMs ?? 500)
    this.reviewTimer.unref?.()
  }

  /**
   * Lists the results again (one listing at a time) and sends `review.needed` for those newly
   * waiting for review, with the latest one and the count; the status follows the count. A
   * result still being built, or re-running with the owner's answers, is not announced until its
   * run is done with it. Never rejects.
   */
  checkReviews(): Promise<void> {
    const run = async () => {
      if (!this.deps.reviews) return
      const { workspaceId, items } = await this.deps.reviews()
      const settled = items.filter((i) => i.settled).map((i) => i.item)
      const key = (i: ReviewItem) => `${i.applicationId}\u0000${i.runId}\u0000${i.finishedAt}`
      const keys = new Set(settled.map(key))
      const seen = this.reviewSeen.get(workspaceId)
      this.reviewSeen.set(workspaceId, keys)
      if (!seen) return
      const fresh = settled.filter((i) => !seen.has(key(i))).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
      if (fresh.length > 0) await this.deps.broadcast('review.needed', { count: settled.length, latest: fresh[0] }, fresh[0].title)
      if (fresh.length > 0 || keys.size !== seen.size) await this.status()
    }
    this.reviewScan = this.reviewScan.then(run).catch((err: unknown) => console.error('[remote] listing reviews failed:', err))
    return this.reviewScan
  }

  private async finished(summary: DesktopPipelineSummary): Promise<void> {
    const c = summary.counts
    const look = c.needsAttention + c.needsReply + c.failed
    const text = `${c.unreviewed} ready for review · ${look} need a look`
    await this.deps.broadcast('pipeline.finished', projectPipelineSummary(summary), text)
    await this.status()
  }
}
