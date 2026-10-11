import type { PipelineState, PipelineStatus } from '@shared/pipeline-types'
import type { UiTone } from '../ui'

export interface PipelineMini {
  status: { label: string; tone: UiTone }
  /** Jobs finished one way or another, of the jobs the pipeline took on (skipped ones left out). */
  done: number
  total: number
  /** 0–100. */
  percent: number
  /** `5 of 20 jobs · ~40 min · $3.20 / $10`. */
  facts: string
}

const STATUS: Record<Exclude<PipelineStatus, 'finished'>, { label: string; tone: UiTone }> = {
  running: { label: 'Running', tone: 'trail' },
  paused: { label: 'Paused', tone: 'warning' },
  'waiting-limit': { label: 'Waiting', tone: 'warning' },
  'stopped-budget': { label: 'Budget hit', tone: 'danger' },
  stopping: { label: 'Stopping', tone: 'neutral' }
}

/** `$10`, `$3.20`. */
export function dollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`
}

/** What the sidebar card shows for an unattended pipeline; `null` once it finished (or without one). */
export function pipelineMini(state: PipelineState | null): PipelineMini | null {
  if (!state || state.status === 'finished') return null
  const c = state.counts
  const total = Math.max(0, c.total - c.skipped)
  const done = Math.max(0, Math.min(total, total - c.queued - c.running))
  const facts = [`${done} of ${total} jobs`]
  if (state.status === 'running' && state.etaMinutes !== null && state.etaMinutes > 0) facts.push(`~${Math.round(state.etaMinutes)} min`)
  const cap = state.budget?.maxCostUsd
  if (cap !== undefined) facts.push(`$${state.costUsd.toFixed(2)} / ${dollars(cap)}`)
  else if (state.costUsd > 0) facts.push(`$${state.costUsd.toFixed(2)}`)
  return {
    status: STATUS[state.status],
    done,
    total,
    percent: total ? (done / total) * 100 : 0,
    facts: facts.join(' · ')
  }
}
