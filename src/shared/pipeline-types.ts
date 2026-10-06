import type { QueueOptions } from './queue-types'
import type { AgentId } from './runner-types'

/**
 * The unattended pipeline (#31): up to 100 saved jobs tailored without anyone
 * watching. One record over unattended queue items plus policy: usage-limit
 * pause with a parsed reset time, backoff, a stall watchdog, keep-awake,
 * restart recovery, an optional budget, the verify gate and a summary. The
 * shapes here are what `pipeline/ipc.ts` exposes now and what #41's gateway
 * projects for the phone (`pipeline.*` commands, `pipeline.changed` /
 * `pipeline.finished` events).
 */

export type PipelineStatus = 'running' | 'paused' | 'waiting-limit' | 'stopped-budget' | 'stopping' | 'finished'

export interface PipelineBudget {
  /** Claude runs only (Codex and Antigravity report tokens, not dollars). */
  maxCostUsd?: number
  /** Counts every agent. */
  maxJobs?: number
}

export interface PipelineOptions extends QueueOptions {
  agent: AgentId
  /** Used for the jobs not started yet when `agent` hits a usage limit. */
  fallbackAgent?: AgentId
  concurrency: number
  budget?: PipelineBudget
  resumeAfterRestart: boolean
  /** Skip jobs that already have an application folder. */
  skipTailored: boolean
  /** A run with no output for this long is killed and retried. */
  stallMinutes: number
}

export interface PipelineStartInput {
  jobIds: string[]
  options: QueueOptions
  agent?: AgentId
  fallbackAgent?: AgentId
  concurrency?: number
  budget?: PipelineBudget
  resumeAfterRestart?: boolean
  skipTailored?: boolean
  stallMinutes?: number
}

export interface PipelineSkip {
  jobId: string
  title: string
  reason: string
}

/** Pre-flight result: what would run, what is skipped and why, and whether anything blocks the start. */
export interface PipelinePlan {
  agent: AgentId
  fallbackAgent?: AgentId
  concurrency: number
  ready: { jobId: string; title: string }[]
  skipped: PipelineSkip[]
  /** Reasons the pipeline cannot start (agent missing or signed out, skill, shared dependencies, disk). */
  blockers: string[]
  warnings: string[]
  /** Median of the last unattended runs × ready ÷ concurrency; `null` without history. */
  estimateMinutes: number | null
  /** Claude only. */
  estimateCostUsd: number | null
  onBattery: boolean
}

export interface PipelineLimit {
  agent: AgentId
  /** ISO time the pipeline tries again (reset + 2 min, or a guess when unparsed). */
  until: string
  kind: 'usage-limit' | 'spend-limit'
  message: string
  parsed: boolean
}

/** Persisted in `queue.json` under `pipeline` (one at a time). */
export interface PipelineRecord {
  /** `p-<run id style>`. */
  id: string
  status: PipelineStatus
  options: PipelineOptions
  itemIds: string[]
  skipped: PipelineSkip[]
  /** Active limits per agent; the panel shows the one the remaining jobs wait for. */
  limits: Partial<Record<AgentId, PipelineLimit>>
  /** Unparsed limits seen so far (60 min, 2 h, 4 h waits). */
  unparsedStrikes: number
  startedAt: string
  finishedAt?: string
  /** Cost of each run seen so far (counted once per run). */
  runCosts: Record<string, number>
  /** ms per job from run history, for the ETA. */
  estimateMsPerJob: number | null
  /** The app died while the pipeline was running. */
  interruptedAt?: string
  /** Why it is paused, stopped or finished early (budget, spend limit, start error, Stop). */
  stopReason?: string
}

export interface PipelineCounts {
  queued: number
  running: number
  needsReply: number
  unreviewed: number
  needsAttention: number
  /** Done results the user approved or discarded since (#72): no longer waiting for review. */
  approved: number
  discarded: number
  failed: number
  cancelled: number
  skipped: number
  total: number
}

/** What the Tailor page's pipeline panel (and the phone) shows. */
export interface PipelineState {
  id: string
  status: PipelineStatus
  /** waiting-limit: when it resumes by itself. */
  until?: string
  limitAgent?: AgentId
  limitMessage?: string
  /** A fallback agent took over for the remaining jobs. */
  fallbackActive?: boolean
  counts: PipelineCounts
  startedAt: string
  finishedAt?: string
  etaMinutes: number | null
  costUsd: number
  budget?: PipelineBudget
  startedJobs: number
  onBattery: boolean
  keepAwake: boolean
  warnings: string[]
  /** Claude's latest utilisation (0–1) reported by a running job. */
  utilization?: number
  interrupted: boolean
  stopReason?: string
  agent: AgentId
  fallbackAgent?: AgentId
  concurrency: number
}

export type PipelineItemOutcome = 'unreviewed' | 'needs-attention' | 'approved' | 'discarded' | 'needs-reply' | 'failed' | 'cancelled'

/** Written to `.huntgry/pipeline-summary.json` when a pipeline finishes (the Dashboard's card). */
export interface PipelineSummary {
  id: string
  startedAt: string
  finishedAt: string
  counts: PipelineCounts
  costUsd: number
  stopReason?: string
  items: { jobId: string; title: string; outcome: PipelineItemOutcome; applicationId?: string; error?: string }[]
  skipped: PipelineSkip[]
}

export interface PipelineApi {
  /** Pre-flight without side effects. */
  plan(input: PipelineStartInput): Promise<PipelinePlan>
  /** Plans again, refuses on blockers, queues the ready jobs as unattended items and starts. */
  start(input: PipelineStartInput): Promise<PipelineState>
  pause(): Promise<PipelineState>
  /** Also after a budget stop, with a raised budget. */
  resume(options?: { budget?: PipelineBudget }): Promise<PipelineState>
  /** Cancels its queued jobs and stops its running ones; done items stay. */
  stop(): Promise<PipelineState>
  state(): Promise<PipelineState | null>
  lastSummary(): Promise<PipelineSummary | null>
  /** Clears a finished pipeline from the Tailor page (its queue items stay). */
  dismiss(): Promise<void>
}

export const PIPELINE_CHANNELS = {
  plan: 'pipeline:plan',
  start: 'pipeline:start',
  pause: 'pipeline:pause',
  resume: 'pipeline:resume',
  stop: 'pipeline:stop',
  state: 'pipeline:state',
  lastSummary: 'pipeline:last-summary',
  dismiss: 'pipeline:dismiss'
} as const

export interface PipelineEvents {
  /** The pipeline's state changed; `null` when there is none. */
  'pipeline:changed': PipelineState | null
  'pipeline:finished': PipelineSummary
}

export const DEFAULT_STALL_MINUTES = 20
export const MIN_STALL_MINUTES = 5
export const MAX_STALL_MINUTES = 60
export const MAX_BUDGET_USD = 10_000
/** Free disk the pre-flight wants (PDF builds, page images, TeX aux files). */
export const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024
/** Keep the Mac awake while waiting for a limit that resets within this time. */
export const KEEP_AWAKE_MAX_WAIT_MS = 6 * 3600_000
/** Duration used for the estimate when there is no run history yet. */
export const FALLBACK_JOB_MINUTES = 8

export const PIPELINE_STATUS_LABEL: Record<PipelineStatus, { label: string; color: string }> = {
  running: { label: 'Running', color: 'blue' },
  paused: { label: 'Paused', color: 'yellow' },
  'waiting-limit': { label: 'Waiting for the limit to reset', color: 'orange' },
  'stopped-budget': { label: 'Stopped: budget reached', color: 'red' },
  stopping: { label: 'Stopping', color: 'gray' },
  finished: { label: 'Finished', color: 'green' }
}

/** The wording shown wherever the unattended mode is explained. */
export const UNATTENDED_EXPLANATION =
  'Unattended runs use only your master-profile facts and your standing approvals. Every other reframing is left out and listed for your review. Results stay Unreviewed and cannot be auto-applied until you approve them on the Review page.'

export const BATTERY_WARNING =
  'On battery: closing the lid still puts the Mac to sleep. Keep it plugged in and open, or run "caffeinate -s" in a terminal.'
