import { addUsage, totalTokens, ZERO_USAGE } from './pricing'
import type { RunSummary, TurnMetrics } from './runner-types'
import type { UsageBatch, UsageDay, UsageFilter, UsageGroup, UsageRunRow, UsageSummary, UsageTotals } from './usage-types'

/**
 * Totals across runs for the Dashboard (#44). Pure: the main process passes the runs (already
 * priced and backfilled) and the clock. Every figure is a sum of per-turn `metrics`, so the
 * totals always equal the sum of the per-run numbers the Tailor page shows.
 */

const DAY = 24 * 3600_000
const RANGE_DAYS = { '7d': 7, '30d': 30 } as const

function emptyTotals(): UsageTotals {
  return { runs: 0, turns: 0, activeMs: 0, usage: { ...ZERO_USAGE }, estimatedCostUsd: 0, unpricedTurns: 0 }
}

function addTurn(t: UsageTotals, m: TurnMetrics): void {
  t.turns++
  t.activeMs += m.activeMs
  t.usage = addUsage(t.usage, m.usage)
  if (m.estimatedCostUsd === null) t.unpricedTurns++
  else t.estimatedCostUsd += m.estimatedCostUsd
}

/** Local `YYYY-MM-DD`. */
export function localDay(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function runBatchId(run: Pick<RunSummary, 'params'>): string | null {
  return run.params.batchId ?? null
}

/** Does the run pass the filter (everything but the range, which `summarizeUsage` checks)? */
function matches(run: RunSummary, f: UsageFilter): boolean {
  if (f.agents?.length && !f.agents.includes(run.agent)) return false
  if (f.statuses?.length && !f.statuses.includes(run.status)) return false
  if (f.batchId && runBatchId(run) !== f.batchId) return false
  if (f.models?.length) {
    const used = new Set([...(run.metrics ?? []).map((m) => m.model ?? ''), run.model ?? ''])
    if (!f.models.some((m) => used.has(m))) return false
  }
  return true
}

export function runRow(run: RunSummary, now: number): UsageRunRow {
  const metrics = run.metrics ?? []
  const t = emptyTotals()
  for (const m of metrics) addTurn(t, m)
  let reported: number | null = null
  for (const m of metrics) if (m.reportedCostUsd !== undefined) reported = (reported ?? 0) + m.reportedCostUsd
  const end = run.status === 'running' || run.status === 'waiting' ? now : Date.parse(run.updatedAt)
  const wall = Math.max(0, end - Date.parse(run.createdAt))
  return {
    id: run.id,
    title: run.title,
    agent: run.agent,
    model: run.model ?? [...metrics].reverse().find((m) => m.model)?.model ?? null,
    status: run.status,
    createdAt: run.createdAt,
    batchId: runBatchId(run),
    outputFolder: run.outputFolder,
    built: run.outputFiles.includes('resume.pdf'),
    turns: metrics.length,
    activeMs: t.activeMs,
    waitingMs: Number.isFinite(wall) ? Math.max(0, wall - t.activeMs) : 0,
    usage: t.usage,
    estimatedCostUsd: metrics.length > 0 && t.unpricedTurns === metrics.length && totalTokens(t.usage) > 0 ? null : t.estimatedCostUsd,
    unpricedTurns: t.unpricedTurns,
    reportedCostUsd: reported,
    backfilled: run.backfilled === true
  }
}

export function summarizeUsage(allRuns: readonly RunSummary[], filter: UsageFilter = {}, now = Date.now()): UsageSummary {
  const days = filter.range && filter.range !== 'all' ? RANGE_DAYS[filter.range] : null
  const since = days === null ? -Infinity : now - days * DAY
  const runs = allRuns.filter((r) => Date.parse(r.createdAt) >= since && matches(r, filter))

  const totals = { ...emptyTotals(), built: 0, failedCostUsd: 0 }
  const groups = new Map<string, UsageGroup & { ids: Set<string> }>()
  const byDay = new Map<string, UsageDay>()
  const batches = new Map<string, UsageBatch & { ids: Set<string> }>()

  for (const run of runs) {
    totals.runs++
    if (run.outputFiles.includes('resume.pdf')) totals.built++
    const batchId = runBatchId(run)
    let batch: (UsageBatch & { ids: Set<string> }) | undefined
    if (batchId) {
      batch = batches.get(batchId)
      if (!batch) {
        batch = { ...emptyTotals(), batchId, agents: [], firstAt: run.createdAt, lastAt: run.createdAt, built: 0, ids: new Set() }
        batches.set(batchId, batch)
      }
      batch.ids.add(run.id)
      batch.runs = batch.ids.size
      if (!batch.agents.includes(run.agent)) batch.agents.push(run.agent)
      if (run.createdAt < batch.firstAt) batch.firstAt = run.createdAt
      if (run.createdAt > batch.lastAt) batch.lastAt = run.createdAt
      if (run.outputFiles.includes('resume.pdf')) batch.built++
    }
    for (const m of run.metrics ?? []) {
      addTurn(totals, m)
      if (run.status === 'failed' && m.estimatedCostUsd !== null) totals.failedCostUsd += m.estimatedCostUsd
      const key = `${run.agent}\u0000${m.model ?? ''}`
      let g = groups.get(key)
      if (!g) {
        g = { ...emptyTotals(), agent: run.agent, model: m.model, ids: new Set() }
        groups.set(key, g)
      }
      addTurn(g, m)
      g.ids.add(run.id)
      g.runs = g.ids.size
      const day = localDay(m.startedAt)
      const d = byDay.get(day) ?? { day, tokens: 0, estimatedCostUsd: 0, activeMs: 0 }
      d.tokens += totalTokens(m.usage)
      d.estimatedCostUsd += m.estimatedCostUsd ?? 0
      d.activeMs += m.activeMs
      byDay.set(day, d)
      if (batch) addTurn(batch, m)
    }
  }

  const strip = <T extends { ids: Set<string> }>({ ids: _ids, ...rest }: T): Omit<T, 'ids'> => rest
  const models = [
    ...new Set(allRuns.flatMap((r) => [...(r.metrics ?? []).map((m) => m.model), r.model]).filter((m): m is string => !!m))
  ].sort()
  return {
    totals,
    byAgentModel: [...groups.values()]
      .map(strip)
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || totalTokens(b.usage) - totalTokens(a.usage)),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    batches: [...batches.values()]
      .map((b) => ({ ...strip(b), agents: [...b.agents].sort() }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    runs: runs.map((r) => runRow(r, now)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    models,
    generatedAt: new Date(now).toISOString()
  }
}

/** A field for a CSV line (RFC 4180), guarded against spreadsheet formula injection. */
function csvField(v: string | number | boolean | null): string {
  if (v === null) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const USAGE_CSV_HEADER = [
  'run_id',
  'created_at',
  'title',
  'agent',
  'model',
  'status',
  'batch_id',
  'application',
  'built',
  'turns',
  'active_seconds',
  'waiting_seconds',
  'input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'output_tokens',
  'reasoning_tokens',
  'estimated_cost_usd',
  'unpriced_turns',
  'reported_cost_usd',
  'backfilled'
] as const

/** One line per run, the per-run numbers of the summary. */
export function usageCsv(rows: readonly UsageRunRow[]): string {
  const lines = rows.map((r) =>
    [
      r.id,
      r.createdAt,
      r.title,
      r.agent,
      r.model,
      r.status,
      r.batchId,
      r.outputFolder,
      r.built,
      r.turns,
      Math.round(r.activeMs / 1000),
      Math.round(r.waitingMs / 1000),
      r.usage.inputTokens,
      r.usage.cacheReadTokens,
      r.usage.cacheWriteTokens,
      r.usage.outputTokens,
      r.usage.reasoningTokens,
      r.estimatedCostUsd === null ? null : r.estimatedCostUsd.toFixed(6),
      r.unpricedTurns,
      r.reportedCostUsd === null ? null : r.reportedCostUsd.toFixed(6),
      r.backfilled
    ]
      .map(csvField)
      .join(',')
  )
  return `${[USAGE_CSV_HEADER.join(','), ...lines].join('\r\n')}\r\n`
}

