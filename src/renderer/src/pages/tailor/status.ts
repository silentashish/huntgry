import type { PipelineStatus } from '@shared/pipeline-types'
import type { QueueItemOutcome, QueueItemStatus } from '@shared/queue-types'
import { AGENT_LABEL, type AgentId, type RunStatus, type RunSummary } from '@shared/runner-types'
import { formatUsage } from '@shared/transcript'
import type { UiTone } from '../../components/ui'
import { runBadge } from '../../components/usage/format'

/** `color` is the Mantine colour other pages read; `tone` the Scent Trail pill tone of this page. */
interface Meta {
  label: string
  color: string
  tone: UiTone
}

export const STATUS_LABEL: Record<RunStatus, Meta> = {
  running: { label: 'Working', color: 'blue', tone: 'info' },
  waiting: { label: 'Waiting for you', color: 'yellow', tone: 'warning' },
  finished: { label: 'Finished', color: 'green', tone: 'success' },
  failed: { label: 'Failed', color: 'red', tone: 'danger' },
  stopped: { label: 'Stopped', color: 'gray', tone: 'neutral' }
}

export const QUEUE_STATUS_LABEL: Record<QueueItemStatus, Meta> = {
  queued: { label: 'Queued', color: 'gray', tone: 'neutral' },
  preparing: { label: 'Starting', color: 'cyan', tone: 'trail' },
  running: { label: 'Working', color: 'blue', tone: 'info' },
  'needs-reply': { label: 'Needs your reply', color: 'yellow', tone: 'warning' },
  done: { label: 'Done', color: 'green', tone: 'success' },
  failed: { label: 'Failed', color: 'red', tone: 'danger' },
  cancelled: { label: 'Cancelled', color: 'gray', tone: 'neutral' }
}

/** Pill tone of the unattended pipeline's status (its labels live in `PIPELINE_STATUS_LABEL`). */
export const PIPELINE_TONE: Record<PipelineStatus, UiTone> = {
  running: 'trail',
  paused: 'warning',
  'waiting-limit': 'accent',
  'stopped-budget': 'danger',
  stopping: 'neutral',
  finished: 'success'
}

/** `Codex is working`, `Waiting for you`, … */
export function runStatusLabel(status: RunStatus, agent: AgentId): string {
  return status === 'running' ? `${AGENT_LABEL[agent]} is working` : STATUS_LABEL[status].label
}

/** What a run took: `2m 14s · 48k tok · $0.31` (#44); the CLI's own figure for a run with no metrics. */
export function runCost(run: Pick<RunSummary, 'costUsd' | 'usage' | 'totals'>): string {
  return runBadge(run) ?? (run.usage && run.costUsd === 0 ? formatUsage(run.usage) : `$${run.costUsd.toFixed(2)}`)
}

/** Mantine color of each agent's badge. */
export const AGENT_COLOR: Record<AgentId, string> = { claude: 'orange', codex: 'teal', antigravity: 'indigo' }

/** Pill tone of each agent (Figma: Claude Ember, Codex Trail, Antigravity Review). */
export const AGENT_TONE: Record<AgentId, UiTone> = { claude: 'accent', codex: 'trail', antigravity: 'review' }

/** Badge for an unattended item's review state. */
export const OUTCOME_LABEL: Record<QueueItemOutcome, Meta> = {
  unreviewed: { label: 'Unreviewed', color: 'yellow', tone: 'warning' },
  'needs-attention': { label: 'Needs attention', color: 'orange', tone: 'accent' },
  approved: { label: 'Approved', color: 'green', tone: 'success' },
  discarded: { label: 'Discarded', color: 'gray', tone: 'neutral' }
}

/** A done unattended result still waiting for the user's review (no outcome: saved before the verify gate recorded one). */
export const awaitsReview = (outcome: QueueItemOutcome | undefined): boolean =>
  outcome === undefined || outcome === 'unreviewed' || outcome === 'needs-attention'

/** Short chip text for what last went wrong with an unattended item. */
export const FAILURE_LABEL: Record<string, string> = {
  'usage-limit': 'usage limit',
  'spend-limit': 'spend limit',
  'burst-limit': 'burst limit',
  transient: 'transient error',
  stall: 'stalled',
  permanent: 'error',
  'start-error': 'could not start'
}

/** When a run started, as the run list reads it: `today 10:42`, `yesterday`, `2 Oct`, `2 Oct 2025`. */
export function shortWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (d.toDateString() === now.toDateString()) {
    return `today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday'
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}${sameYear ? '' : ` ${d.getFullYear()}`}`
}

/**
 * What a new run with `agent` usually takes, from this workspace's finished runs of that agent:
 * `~4 min · ≈ $0.40 based on your last 5 Claude runs`; `null` with no measured run.
 */
export function runEstimate(runs: readonly RunSummary[], agent: AgentId, last = 10): string | null {
  const measured = runs
    .filter((r) => r.agent === agent && r.status !== 'failed' && r.totals && r.totals.turns > 0 && r.totals.activeMs > 0)
    .slice(0, last)
  if (measured.length === 0) return null
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const minutes = Math.max(1, Math.round(median(measured.map((r) => r.totals!.activeMs)) / 60_000))
  const priced = measured.filter((r) => r.totals!.unpricedTurns === 0)
  const cost = priced.length ? ` · ≈ $${median(priced.map((r) => r.totals!.estimatedCostUsd)).toFixed(2)}` : ''
  const n = measured.length
  return `~${minutes} min${cost} based on your last ${n === 1 ? '' : `${n} `}${AGENT_LABEL[agent]} run${n === 1 ? '' : 's'}`
}
