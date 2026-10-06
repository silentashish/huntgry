import type { ModelPrice } from './pricing'
import type { AgentId, RunStatus, TokenUsage } from './runner-types'

/**
 * Run observability across runs (#44): what the Dashboard's Usage card asks the main process
 * for. Every number comes from the runs' per-turn `metrics`; the renderer only shows them.
 */

export const USAGE_RANGES = ['7d', '30d', 'all'] as const
export type UsageRange = (typeof USAGE_RANGES)[number]

export interface UsageFilter {
  /** Runs created in the last 7 / 30 days, or all of them. */
  range?: UsageRange
  agents?: AgentId[]
  /** Model ids as recorded (a run counts when any of its turns used one of them, sub-agents included). */
  models?: string[]
  statuses?: RunStatus[]
  /** Only the runs of one "Tailor all" request / pipeline. */
  batchId?: string
}

/** One run's numbers (the CSV export has one line per run). */
export interface UsageRunRow {
  id: string
  title: string
  agent: AgentId
  /** The run's last model; `null` = unknown. */
  model: string | null
  status: RunStatus
  createdAt: string
  batchId: string | null
  outputFolder: string | null
  /** The run built a resume (`resume.pdf`). */
  built: boolean
  turns: number
  activeMs: number
  /** Wall time since the run started, minus `activeMs`: time spent waiting for the user. */
  waitingMs: number
  usage: TokenUsage
  /** Sum of its priced turns; `null` when no turn could be priced. */
  estimatedCostUsd: number | null
  unpricedTurns: number
  /** Turns that never ended (stop, crash): tokens and cost are a lower bound. */
  incompleteTurns: number
  /** What the CLI reported (Claude). */
  reportedCostUsd: number | null
  /** Metrics rebuilt from `events.jsonl` (approximate active time). */
  backfilled: boolean
}

/** Sums over a set of runs (or turns). */
export interface UsageTotals {
  runs: number
  turns: number
  activeMs: number
  usage: TokenUsage
  estimatedCostUsd: number
  /** Turns whose model has no price; `estimatedCostUsd` leaves them out. */
  unpricedTurns: number
  /** Turns that never ended: their tokens and cost are a lower bound. */
  incompleteTurns: number
}

export interface UsageGroup extends UsageTotals {
  agent: AgentId
  /** `null` = unknown model. */
  model: string | null
}

export interface UsageDay {
  /** Local date, `YYYY-MM-DD`. */
  day: string
  tokens: number
  estimatedCostUsd: number
  activeMs: number
}

export interface UsageBatch extends UsageTotals {
  batchId: string
  agents: AgentId[]
  firstAt: string
  lastAt: string
  built: number
}

export interface UsageSummary {
  totals: UsageTotals & {
    /** Runs that built a resume. */
    built: number
    /** Estimated cost of the failed runs (part of the total). */
    failedCostUsd: number
  }
  /** Per agent × model, from the turns (a run that changed model counts in both). */
  byAgentModel: UsageGroup[]
  /** Oldest first, only days with a turn. */
  byDay: UsageDay[]
  /** Newest first. */
  batches: UsageBatch[]
  /** Newest first. */
  runs: UsageRunRow[]
  /** Every model seen in the workspace's runs, for the filter (whatever the filter). */
  models: string[]
  generatedAt: string
}

/** Settings → Pricing. */
export interface PricingState {
  /** Bundled table with the user's entries applied (`custom` marks those). */
  prices: ModelPrice[]
  /** Bundled ids, so the page can offer "Reset" per changed model. */
  bundledIds: string[]
}
