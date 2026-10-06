import type { PipelinePlan, PipelineState, PipelineStatus } from '@shared/pipeline-types'
import { AGENT_LABEL } from '@shared/runner-types'

/** Pure helpers for the unattended mode of the bulk modal and the pipeline panel (unit-tested). */

export function formatMinutes(minutes: number): string {
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** `until 14:05`, or `until tomorrow 09:00` / `until Mon 09:00` when it is not today. */
export function formatUntil(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `until ${time}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `until tomorrow ${time}`
  return `until ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

/** What the plan step says: how many run, how many are skipped, how long and how much. */
export function planSummary(plan: PipelinePlan): { ready: string; skipped: string | null; estimate: string; cost: string | null } {
  const n = plan.ready.length
  const ready = n === 0 ? 'No job can run.' : `${n} job${n === 1 ? '' : 's'} will run unattended, ${plan.concurrency} at a time.`
  const skipped = plan.skipped.length ? `${plan.skipped.length} skipped:` : null
  const estimate = n === 0 ? '' : `About ${formatMinutes(plan.estimateMinutes ?? 0)}.`
  const cost =
    plan.estimateCostUsd !== null
      ? `Roughly $${plan.estimateCostUsd.toFixed(2)} (median of your recent unattended ${AGENT_LABEL[plan.agent]} runs).`
      : plan.agent === 'claude' && n > 0
        ? 'No cost estimate yet (no finished unattended Claude runs).'
        : null
  return { ready, skipped, estimate, cost }
}

const STATUS_TEXT: Record<PipelineStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  'waiting-limit': 'Waiting for the limit to reset',
  'stopped-budget': 'Stopped: budget reached',
  stopping: 'Stopping',
  finished: 'Finished'
}

/** One line for the panel: `Waiting for Claude's limit · until 14:05 · resumes by itself`. */
export function statusLine(state: PipelineState, now = new Date()): string {
  switch (state.status) {
    case 'waiting-limit':
      return `Waiting for ${state.limitAgent ? `${AGENT_LABEL[state.limitAgent]}'s` : 'the'} limit · ${state.until ? formatUntil(state.until, now) : 'reset time unknown'} · resumes by itself`
    case 'running':
      return state.fallbackActive && state.limitAgent
        ? `Running with ${state.fallbackAgent ? AGENT_LABEL[state.fallbackAgent] : 'the fallback agent'} (${AGENT_LABEL[state.limitAgent]} hit its limit)`
        : state.etaMinutes !== null && state.etaMinutes > 0
          ? `Running · about ${formatMinutes(state.etaMinutes)} left`
          : 'Running'
    case 'paused':
    case 'stopped-budget':
      return state.stopReason ? `${STATUS_TEXT[state.status]} · ${state.stopReason}` : STATUS_TEXT[state.status]
    case 'finished':
      return state.stopReason ? `Finished · ${state.stopReason}` : 'Finished'
    default:
      return STATUS_TEXT[state.status]
  }
}

/** Progress of a pipeline as a fraction of its items that reached an end state. */
export function progress(state: PipelineState): number {
  const c = state.counts
  const items = c.total - c.skipped
  if (items <= 0) return 0
  const ended = c.unreviewed + c.needsAttention + c.approved + c.discarded + c.needsReply + c.failed + c.cancelled
  return Math.round((ended / items) * 100)
}
