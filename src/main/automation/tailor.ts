import { DEFAULT_STALL_MINUTES, type PipelineState } from '@shared/pipeline-types'
import type { QueueItem, QueueOptions, QueueState } from '@shared/queue-types'
import type { AgentId, RunSummary } from '@shared/runner-types'
import type { Pipeline } from '../pipeline/pipeline'
import type { TailorDeps, TailorResult } from './service'

/**
 * Automation's tailoring (#154) is the unattended pipeline (#31), never a second path: one pipeline per job,
 * started with `origin: 'automation'`, so its verify gate, bounded retries, usage-limit waits, stall watchdog and
 * keep-awake apply as to any pipeline. Only one pipeline exists at a time: Automation waits while another one
 * (the user's "Tailor all", the phone's) is running, and while the queue is paused with jobs of its own, since
 * starting a pipeline unpauses the whole queue.
 */

export interface PipelineTailorDeps {
  pipeline: Pick<Pipeline, 'start' | 'state' | 'pause' | 'resume' | 'stop'>
  queue: { state(): QueueState; isPaused(): boolean; itemsOf(pipelineId: string): QueueItem[] }
  /** Every `queue:changed`; returns the unsubscribe function. */
  onQueueChange(listener: (state: QueueState) => void): () => void
  /** The agent new tailoring runs use (Settings → Agents). */
  agent(): Promise<AgentId>
  options(coverLetter: boolean): QueueOptions
  listRuns(workspace: string): Promise<RunSummary[]>
  readRun(workspace: string, runId: string): Promise<RunSummary | null>
  /** How often a wait looks at the queue besides its events; 2 s by default. */
  pollMs?: number
}

const ACTIVE = new Set<QueueItem['status']>(['queued', 'preparing', 'running'])

/** Where an item is: still working, or how it ended. */
export function resultOf(item: QueueItem): TailorResult | 'working' {
  if (ACTIVE.has(item.status)) return 'working'
  const status = item.status === 'done' || item.status === 'cancelled' || item.status === 'needs-reply' ? item.status : 'failed'
  return {
    status,
    ...(item.outcome ? { outcome: item.outcome } : {}),
    ...(item.applicationId ? { applicationId: item.applicationId } : {}),
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.error ? { error: item.error } : {})
  }
}

/** A run's cost: estimated from tokens (every agent), else what Claude reported. */
export function runCost(run: RunSummary | null): number {
  if (!run) return 0
  const estimate = run.totals?.estimatedCostUsd
  return estimate && estimate > 0 ? estimate : run.costUsd || 0
}

const isAutomation = (s: PipelineState | null) => s?.origin === 'automation' && s.status !== 'finished'

export function pipelineTailor(deps: PipelineTailorDeps): TailorDeps {
  const find = (itemId: string) => deps.queue.state().items.find((i) => i.id === itemId)
  return {
    blocked: () => {
      const running = deps.pipeline.state()
      if (running && running.status !== 'finished')
        return running.origin === 'automation' ? 'Waiting for the last tailoring run to wrap up.' : 'Waiting for the running pipeline to finish.'
      const q = deps.queue.state()
      if (deps.queue.isPaused() && q.items.some((i) => i.status === 'queued'))
        return 'Waiting: the tailoring queue is paused with jobs in it (starting would unpause them). Resume or clear it on the Tailor page.'
      return null
    },
    start: async (ws, jobId, { automationRunId, coverLetter, retry }) => {
      const state = await deps.pipeline.start(
        {
          jobIds: [jobId],
          options: deps.options(coverLetter),
          agent: await deps.agent(),
          // The queue's own concurrency: a pipeline start sets it, and Automation runs one job at a time anyway.
          concurrency: deps.queue.state().concurrency,
          resumeAfterRestart: false,
          // New jobs never run twice; the user's Retry of a result that needs attention is the one exception.
          skipTailored: !retry,
          stallMinutes: DEFAULT_STALL_MINUTES,
          origin: 'automation',
          automationRunId
        },
        ws
      )
      const item = deps.queue.itemsOf(state.id)[0]
      if (!item) throw new Error('The pipeline queued no job.')
      return { itemId: item.id }
    },
    wait: (itemId, signal) =>
      new Promise<TailorResult>((resolve) => {
        let settled = false
        const finish = (r: TailorResult) => {
          if (settled) return
          settled = true
          off()
          clearInterval(poll)
          signal.removeEventListener('abort', aborted)
          resolve(r)
        }
        const check = () => {
          const item = find(itemId)
          const r: TailorResult | 'working' = item ? resultOf(item) : { status: 'cancelled', error: 'The job left the queue.' }
          if (r !== 'working') finish(r)
        }
        const aborted = () => finish({ status: 'cancelled', aborted: true })
        const off = deps.onQueueChange(check)
        // A queue reload (workspace switch, restart) changes items without an event for this listener.
        const poll = setInterval(check, deps.pollMs ?? 2000)
        poll.unref?.()
        signal.addEventListener('abort', aborted)
        if (signal.aborted) aborted()
        else check()
      }),
    item: (itemId) => {
      const item = find(itemId)
      return item ? resultOf(item) : null
    },
    pause: async (ws) => {
      if (isAutomation(deps.pipeline.state())) await deps.pipeline.pause(ws)
    },
    resume: async (ws) => {
      const s = deps.pipeline.state()
      if (s?.origin === 'automation' && s.status === 'paused') await deps.pipeline.resume({}, ws)
    },
    stop: async (ws) => {
      if (isAutomation(deps.pipeline.state())) await deps.pipeline.stop(ws)
    },
    medianCostUsd: async (ws) => {
      const costs = (await deps.listRuns(ws))
        .filter((r) => r.status === 'finished' && r.unattended)
        .slice(0, 20)
        .map(runCost)
        .filter((c) => c > 0)
        .sort((a, b) => a - b)
      if (costs.length === 0) return null
      const mid = Math.floor(costs.length / 2)
      return costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2
    },
    costUsd: async (ws, itemId) => {
      const item = find(itemId)
      if (!item) return 0
      // Every attempt of the item records its batch id on its run: a failed attempt the pipeline retried counts too.
      if (item.batchId) {
        const runs = (await deps.listRuns(ws)).filter((r) => r.params.batchId === item.batchId)
        if (runs.length > 0) return Math.round(runs.reduce((sum, r) => sum + runCost(r), 0) * 10000) / 10000
      }
      return item.runId ? runCost(await deps.readRun(ws, item.runId)) : 0
    }
  }
}
