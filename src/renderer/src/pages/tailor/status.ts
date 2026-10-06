import type { QueueItemOutcome, QueueItemStatus } from '@shared/queue-types'
import { AGENT_LABEL, type AgentId, type RunStatus, type RunSummary } from '@shared/runner-types'
import { formatUsage } from '@shared/transcript'
import { runBadge } from '../../components/usage/format'

export const STATUS_LABEL: Record<RunStatus, { label: string; color: string }> = {
  running: { label: 'Working', color: 'blue' },
  waiting: { label: 'Waiting for you', color: 'yellow' },
  finished: { label: 'Finished', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  stopped: { label: 'Stopped', color: 'gray' }
}

export const QUEUE_STATUS_LABEL: Record<QueueItemStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: 'gray' },
  preparing: { label: 'Starting', color: 'cyan' },
  running: { label: 'Working', color: 'blue' },
  'needs-reply': { label: 'Needs your reply', color: 'yellow' },
  done: { label: 'Done', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  cancelled: { label: 'Cancelled', color: 'gray' }
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

/** Badge for an unattended item's review state. */
export const OUTCOME_LABEL: Record<QueueItemOutcome, { label: string; color: string }> = {
  unreviewed: { label: 'Unreviewed', color: 'yellow' },
  'needs-attention': { label: 'Needs attention', color: 'orange' },
  approved: { label: 'Approved', color: 'green' },
  discarded: { label: 'Discarded', color: 'gray' }
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
