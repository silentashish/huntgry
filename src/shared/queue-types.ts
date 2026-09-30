import type { DateStyle } from './runner-types'

/**
 * Bulk tailoring: several saved jobs queued from the Jobs page, started by the
 * main process a few at a time, tracked on the Tailor page. Saved in the
 * workspace as `.huntgry/queue.json`.
 */

export type QueueItemStatus =
  /** Waiting for a free slot. */
  | 'queued'
  /** Reading the full posting and starting Claude. */
  | 'preparing'
  /** Claude is working on a turn (takes a slot). */
  | 'running'
  /** The run stopped at the approval step (or any other question) and waits for the user; the slot is free. */
  | 'needs-reply'
  /** The user ended the run. */
  | 'done'
  /** Could not start, or the run failed; `error` says why. Retryable. */
  | 'failed'
  | 'cancelled'

/** Who runs an item. Only Claude today; #22 widens this. */
export type QueueAgent = 'claude'

/** Run options shared by every job of one bulk request. */
export interface QueueOptions {
  coverLetter: boolean
  dateStyle: DateStyle
  notes?: string
}

export interface QueueItem {
  /** `q-<run id style>`, e.g. `q-20260930-010203-a1b2c3`. */
  id: string
  /** Canonical `Job.id` (a job seen on several boards is one item). */
  jobId: string
  /** `<title> · <company>`, for the list. */
  title: string
  options: QueueOptions
  agent: QueueAgent
  status: QueueItemStatus
  /** The tailoring run, once started. */
  runId: string | null
  error?: string
  /** Retries so far (automatic and manual). */
  attempts: number
  /** The run built `resume.pdf` (it may still wait for the user to finish it). */
  built?: boolean
  /** Not started before this time (ISO); set for the automatic retry after a rate limit. */
  notBefore?: string
  createdAt: string
  updatedAt: string
}

export interface QueueState {
  items: QueueItem[]
  /** Runs Claude may work on at once, 1..`MAX_CONCURRENCY`. */
  concurrency: number
  /** Nothing new starts while paused. The queue opens paused after a restart. */
  paused: boolean
}

export interface EnqueueInput {
  jobIds: string[]
  options: QueueOptions
  /** Also sets the queue's concurrency. */
  concurrency?: number
  agent?: QueueAgent
}

export interface EnqueueResult {
  state: QueueState
  added: number
  /** Jobs not queued, with the reason (already queued, dismissed, no longer saved). */
  skipped: { jobId: string; reason: string }[]
}

export const DEFAULT_CONCURRENCY = 2
export const MAX_CONCURRENCY = 4
/** Most jobs one bulk request may queue. */
export const MAX_ENQUEUE = 100

/** Items that hold (or wait for) a Claude process and are not finished. */
export const ACTIVE_STATUSES: readonly QueueItemStatus[] = ['queued', 'preparing', 'running', 'needs-reply']

export interface QueueApi {
  state(): Promise<QueueState>
  /** Queues the jobs (one IPC call for the whole selection) and resumes the queue. */
  enqueue(input: EnqueueInput): Promise<EnqueueResult>
  /** A queued item is dropped before it starts; a started one has its Claude process stopped. */
  cancel(itemId: string): Promise<QueueState>
  cancelAll(): Promise<QueueState>
  /** Queues a failed or cancelled item again. */
  retry(itemId: string): Promise<QueueState>
  /** Removes an item that is not starting or running; its run stays in the run list. */
  remove(itemId: string): Promise<QueueState>
  /** Removes done and cancelled items. */
  clearFinished(): Promise<QueueState>
  setConcurrency(n: number): Promise<QueueState>
  setPaused(paused: boolean): Promise<QueueState>
}

export const QUEUE_CHANNELS = {
  state: 'queue:state',
  enqueue: 'queue:enqueue',
  cancel: 'queue:cancel',
  cancelAll: 'queue:cancel-all',
  retry: 'queue:retry',
  remove: 'queue:remove',
  clearFinished: 'queue:clear-finished',
  setConcurrency: 'queue:set-concurrency',
  setPaused: 'queue:set-paused'
} as const

export interface QueueEvents {
  /** The queue changed (items, statuses, concurrency, paused). */
  'queue:changed': QueueState
}
