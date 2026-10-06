import { totalTokens } from '@shared/pricing'
import type { RunSummary, RunTotals, TokenUsage, TurnMetrics } from '@shared/runner-types'
import { waitingMsOf } from '@shared/usage'

/** How run time, tokens and estimated cost read everywhere in the app (#44), the same for every agent. */

/** `14s`, `2m 14s`, `1h 05m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** `950`, `48.2k`, `480k`, `1.23M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** `$1.23`, `$0.31`, `$0.0042`; `null` = the model has no price. */
export function formatCost(usd: number | null): string {
  if (usd === null) return 'not priced'
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/**
 * A run's or a total's estimated cost, saying when it is a lower bound: some turns could not be
 * priced, or never ended (their usage is what was reported until then).
 */
export function formatTotalCost(
  t: Pick<RunTotals, 'estimatedCostUsd' | 'unpricedTurns'> & { pricedTurns?: number; incompleteTurns?: number }
): string {
  if (t.unpricedTurns > 0 && (t.pricedTurns === 0 || t.estimatedCostUsd === 0)) return 'not priced'
  if (t.unpricedTurns === 0 && !t.incompleteTurns) return formatCost(t.estimatedCostUsd)
  return `≥ ${formatCost(t.estimatedCostUsd)}`
}

/** `12.3k in · 40.1k cached · 1.2k out (300 reasoning)`. */
export function formatUsageDetail(u: TokenUsage): string {
  const parts = [`${formatTokens(u.inputTokens)} in`]
  if (u.cacheReadTokens) parts.push(`${formatTokens(u.cacheReadTokens)} cached`)
  if (u.cacheWriteTokens) parts.push(`${formatTokens(u.cacheWriteTokens)} cache write`)
  parts.push(`${formatTokens(u.outputTokens)} out${u.reasoningTokens ? ` (${formatTokens(u.reasoningTokens)} reasoning)` : ''}`)
  return parts.join(' · ')
}

/** The compact badge of a run row: `2m 14s · 48k tok · $0.31`; `null` for a run with no turn yet. */
export function runBadge(run: Pick<RunSummary, 'totals'>): string | null {
  const t = run.totals
  if (!t || t.turns === 0) return null
  return `${formatDuration(t.activeMs)} · ${formatTokens(totalTokens(t.usage))} tok · ${formatTotalCost(t)}`
}

/** The footer of one turn in the transcript. */
export function turnFooter(m: TurnMetrics): string {
  if (m.usageIncomplete && totalTokens(m.usage) === 0) return `${formatDuration(m.activeMs)} · usage unknown (the turn did not end)`
  const cost = formatCost(m.estimatedCostUsd)
  return [formatDuration(m.activeMs), formatUsageDetail(m.usage), m.usageIncomplete && m.estimatedCostUsd !== null ? `≥ ${cost}` : cost].join(' · ')
}

/** Wall time since the run started minus its active time: how long it waited for the user (frozen while a turn runs). */
export function waitingMs(run: Pick<RunSummary, 'createdAt' | 'updatedAt' | 'status' | 'totals' | 'turnStartedAt'>, now = Date.now()): number {
  return waitingMsOf(run, run.totals?.activeMs ?? 0, now)
}
