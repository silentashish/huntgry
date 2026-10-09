/**
 * The start sheet's form → `PipelineStartInput` (#41), and the labels the Pipeline screen and
 * the Home card show for a `PipelineState` / `PipelineSummary`. The form can only produce what
 * the package guard accepts (saved job ids, an enum agent and fallback, concurrency 1–4, a
 * numeric budget); the desktop then runs its own validator and pre-flight, as for "Run
 * unattended". Plain TypeScript, tested in Node.
 */

import {
  ProtocolError,
  REMOTE_MAX_CONCURRENCY,
  REMOTE_MAX_JOBS,
  type PipelineCounts,
  type PipelineStartInput,
  type PipelineStatus,
  type PipelineSummary,
  type RemoteAgentId
} from '@huntgry/remote-protocol'
import { commands } from './commands'

export interface PipelineForm {
  jobIds: readonly string[]
  agent: RemoteAgentId
  fallback: RemoteAgentId | null
  concurrency: number
  /** As typed: "" for no limit. */
  maxCostUsd: string
  maxRuns: string
}

/** The desktop's spend cap range (its `requirePipelineStartInput`). */
export const BUDGET_USD = { min: 1, max: 10_000 } as const

export const DEFAULT_CONCURRENCY = 2

export function pipelineStartInput(form: PipelineForm): { input: PipelineStartInput } | { error: string } {
  if (form.jobIds.length === 0) return { error: 'Choose at least one saved job.' }
  if (form.jobIds.length > REMOTE_MAX_JOBS) return { error: `A pipeline takes at most ${REMOTE_MAX_JOBS} jobs.` }
  if (!Number.isInteger(form.concurrency) || form.concurrency < 1 || form.concurrency > REMOTE_MAX_CONCURRENCY) return { error: `Run 1 to ${REMOTE_MAX_CONCURRENCY} jobs at a time.` }
  if (form.fallback === form.agent) return { error: 'The fallback must be another agent.' }
  const input: PipelineStartInput = { jobIds: [...form.jobIds], concurrency: form.concurrency, agent: form.agent }
  if (form.fallback) input.fallback = form.fallback
  const cost = form.maxCostUsd.trim().replace(/^\$/, '')
  const runs = form.maxRuns.trim()
  if (cost || runs) input.budget = {}
  if (cost) {
    if (!/^\d+(\.\d{1,2})?$/.test(cost) || Number(cost) < BUDGET_USD.min || Number(cost) > BUDGET_USD.max) return { error: `A spend limit is $${BUDGET_USD.min} to $${BUDGET_USD.max.toLocaleString('en-US')}.` }
    input.budget!.maxCostUsd = Number(cost)
  }
  if (runs) {
    if (!/^\d+$/.test(runs) || Number(runs) < 1 || Number(runs) > REMOTE_MAX_JOBS) return { error: `A run limit is 1 to ${REMOTE_MAX_JOBS}.` }
    input.budget!.maxRuns = Number(runs)
  }
  try {
    // The package guard, exactly as the desktop runs it first.
    const command = commands.pipelineStart(input)
    return { input: command.name === 'pipeline.start' ? command.args : input }
  } catch (err) {
    return { error: err instanceof ProtocolError ? err.message : 'That pipeline cannot be started.' }
  }
}

export const PIPELINE_STATUS: Record<PipelineStatus, { label: string; tone: 'neutral' | 'trail' | 'warning' | 'success'; live: boolean }> = {
  idle: { label: 'Idle', tone: 'neutral', live: false },
  running: { label: 'Running', tone: 'trail', live: true },
  paused: { label: 'Paused', tone: 'warning', live: false },
  'waiting-limit': { label: 'Waiting for limit', tone: 'warning', live: false },
  finished: { label: 'Finished', tone: 'success', live: false }
}

export type CountTone = 'neutral' | 'info' | 'warning' | 'ember' | 'danger' | 'success'

/** The count badges under the progress card, only those above zero. */
export function countBadges(c: PipelineCounts): { label: string; tone: CountTone }[] {
  const rows: [number | undefined, string, CountTone][] = [
    [c.queued, 'queued', 'neutral'],
    [c.running, 'working', 'info'],
    [c.unreviewed, 'unreviewed', 'warning'],
    [c.needsAttention, 'attention', 'ember'],
    [c.needsReply, 'need a reply', 'warning'],
    [c.failed, 'failed', 'danger'],
    [c.skipped, 'skipped', 'neutral'],
    [c.cancelled, 'cancelled', 'neutral']
  ]
  return rows.filter(([n]) => (n ?? 0) > 0).map(([n, label, tone]) => ({ label: `${n} ${label}`, tone }))
}

/** "18 built · 4 need review · 1 failed · 2 skipped" (the desktop's finished notification, with the split). */
export function summaryLine(s: PipelineSummary): string {
  const c = s.counts
  const review = c.unreviewed + (c.needsAttention ?? 0)
  const parts = [`${c.done} built`, `${review} need${review === 1 ? 's' : ''} review`, `${c.failed} failed`]
  if (c.skipped) parts.push(`${c.skipped} skipped`)
  return parts.join(' · ')
}

export const SUMMARY_TITLE: Record<PipelineSummary['status'], string> = {
  finished: 'Pipeline finished',
  stopped: 'Pipeline stopped',
  budget: 'Pipeline stopped at its budget'
}

/** "about 40 min left", "about 2 h left"; null when there is no estimate or it has passed. */
export function etaText(eta: string | undefined, now: number): string | null {
  if (!eta) return null
  const min = Math.round((Date.parse(eta) - now) / 60_000)
  if (min <= 0) return null
  return min >= 90 ? `about ${Math.round(min / 60)} h left` : `about ${Math.max(1, min)} min left`
}
