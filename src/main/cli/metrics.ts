import { addUsage, estimateTurn, MODEL_PRICES, normalizeModelId, runTotals, totalTokens, ZERO_USAGE, type ModelPrice } from '@shared/pricing'
import type { AgentId, CliCounters, ModelTurnUsage, RunSummary, TokenUsage, TurnMetrics } from '@shared/runner-types'
import { isObj, type TurnEndSignal } from './agents/types'
import { adapterFor } from './agents'

/**
 * Turns what a CLI reports at the end of a turn into that turn's `TurnMetrics` (#44). Shared by
 * the live `RunManager` and the backfill of old runs from `events.jsonl`, so both count the same.
 *
 * Claude's `total_cost_usd` and `modelUsage`, and Codex's `turn.completed.usage`, are the
 * session's running totals (a resumed session continues them), so a turn's share is the
 * difference with the counters the previous turn left (`CliCounters`). A counter that went down
 * means the CLI started counting again: the new value is then the turn's share.
 */

const FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'] as const

function minus(cur: TokenUsage, prev: TokenUsage | undefined): TokenUsage {
  if (!prev || FIELDS.some((f) => cur[f] < prev[f])) return { ...cur }
  const out = { ...ZERO_USAGE }
  for (const f of FIELDS) out[f] = cur[f] - prev[f]
  const h = (cur.cacheWrite1hTokens ?? 0) - (prev.cacheWrite1hTokens ?? 0)
  if (h > 0) out.cacheWrite1hTokens = h
  return out
}

/** `a − b` per field, never below 0 (for tokens already counted elsewhere). */
function less(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a
  const out = { ...ZERO_USAGE }
  for (const f of FIELDS) out[f] = Math.max(0, a[f] - b[f])
  const h = Math.max(0, (a.cacheWrite1hTokens ?? 0) - (b.cacheWrite1hTokens ?? 0))
  if (h > 0) out.cacheWrite1hTokens = h
  return out
}

const minusNum = (cur: number, prev: number | undefined): number => (prev === undefined || cur < prev ? cur : cur - prev)

export interface TurnShare {
  usage: TokenUsage
  models?: ModelTurnUsage[]
  reportedCostUsd?: number
  /** The counters to keep for the next turn. */
  counters: CliCounters
}

/** The turn's share of what `signal` reports, given the counters the previous turn left. */
export function turnShare(signal: TurnEndSignal, counters: CliCounters | undefined, turnModel: string | null): TurnShare {
  const next: CliCounters = { ...(counters ?? {}) }
  // Tokens an interrupted turn was already given; the running totals may include them again now.
  const interrupted = counters?.interrupted
  delete next.interrupted
  const interruptedSum = interrupted ? Object.values(interrupted).reduce((a, u) => addUsage(a, u), { ...ZERO_USAGE }) : undefined
  let usage = signal.usage ? { ...signal.usage } : { ...ZERO_USAGE }
  if (signal.usage && signal.usageScope === 'session') {
    usage = less(minus(signal.usage, counters?.usage), interruptedSum)
    next.usage = signal.usage
  }
  let reportedCostUsd: number | undefined
  if (signal.costUsd !== undefined) {
    reportedCostUsd = minusNum(signal.costUsd, counters?.costUsd)
    next.costUsd = signal.costUsd
  }
  let models: ModelTurnUsage[] | undefined
  if (signal.models) {
    models = []
    for (const [model, m] of Object.entries(signal.models)) {
      const prev = counters?.models?.[model]
      const own = turnModel && normalizeModelId(model) === normalizeModelId(turnModel)
      const share = less(minus(m.usage, prev?.usage), interrupted?.[model] ?? (own ? interrupted?.[''] : undefined))
      const cost = m.costUsd !== undefined ? minusNum(m.costUsd, prev?.costUsd) : undefined
      if (totalTokens(share) === 0 && !cost) continue
      models.push({ model, usage: share, ...(cost !== undefined ? { reportedCostUsd: cost } : {}) })
    }
    next.models = signal.models
    // Claude's per-model counts have no 1-hour split: give the turn's to its own model.
    const oneHour = signal.usage?.cacheWrite1hTokens ?? 0
    if (oneHour > 0) {
      const own = models.find((m) => turnModel && normalizeModelId(m.model) === normalizeModelId(turnModel)) ?? models[0]
      if (own) own.usage = { ...own.usage, cacheWrite1hTokens: Math.min(oneHour, own.usage.cacheWriteTokens) }
    }
    if (models.length > 0) {
      // Sub-agents' tokens are in `modelUsage` only: the turn's usage is the sum over its models.
      const sum = models.reduce((a, m) => addUsage(a, m.usage), { ...ZERO_USAGE })
      if (totalTokens(sum) >= totalTokens(usage)) usage = sum
    } else {
      models = undefined
    }
  }
  return { usage, ...(models ? { models } : {}), ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}), counters: next }
}

/** The model a turn ran: the only one the CLI split it into, else what the CLI or Huntgry said. */
export function turnModel(share: Pick<TurnShare, 'models'>, known: string | null): string | null {
  if (share.models && share.models.length > 0) {
    // The biggest share names the turn (sub-agents on a smaller model do not).
    const top = [...share.models].sort((a, b) => totalTokens(b.usage) - totalTokens(a.usage))[0]
    return known && share.models.some((m) => normalizeModelId(m.model) === normalizeModelId(known)) ? known : top.model
  }
  return known
}

/** A finished turn's metrics, priced at `table`. */
export function turnMetrics(
  base: Omit<TurnMetrics, 'estimatedCostUsd' | 'usage' | 'models' | 'reportedCostUsd'>,
  share: Omit<TurnShare, 'counters'> | null,
  table: readonly ModelPrice[] = MODEL_PRICES
): TurnMetrics {
  const t: Omit<TurnMetrics, 'estimatedCostUsd'> = {
    ...base,
    usage: share?.usage ?? { ...ZERO_USAGE },
    ...(share?.models ? { models: share.models } : {}),
    ...(share?.reportedCostUsd !== undefined ? { reportedCostUsd: share.reportedCostUsd } : {})
  }
  return { ...t, estimatedCostUsd: estimateTurn(t, table) }
}

/** The run's legacy fields kept in step with its metrics (remote protocol, pipeline budget). */
export function legacyFields(metrics: readonly TurnMetrics[], agent: AgentId): Pick<RunSummary, 'costUsd' | 'usage'> {
  const totals = runTotals(metrics)
  const u = totals.usage
  return {
    costUsd: totals.reportedCostUsd ?? 0,
    // Claude never had `usage` (its footer shows dollars); the others keep showing tokens.
    usage: agent === 'claude' ? undefined : { inputTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, outputTokens: u.outputTokens }
  }
}

/**
 * Rebuilds `metrics` of a run recorded before #44 from its `events.jsonl`. Tokens and models are
 * exact (the raw lines hold them); active time runs from each `user_message` to the turn's end:
 * the end's own time is unknown, so the CLI's duration is used when it gives one (Claude,
 * Antigravity), otherwise the time until the next message (approximate, capped at an hour).
 */
export function backfillMetrics(
  run: Pick<RunSummary, 'agent' | 'createdAt' | 'updatedAt' | 'model'>,
  events: readonly unknown[],
  defaultModel: string | null,
  table: readonly ModelPrice[] = MODEL_PRICES
): { metrics: TurnMetrics[]; counters: CliCounters; model: string | null } {
  const adapter = adapterFor(run.agent)
  const metrics: TurnMetrics[] = []
  let counters: CliCounters = {}
  let model: string | null = run.model ?? defaultModel
  let turn = 0
  let startedAt: string | null = null
  let open = false
  const messageTimes: string[] = []
  for (const ev of events) if (isObj(ev) && ev.type === 'huntgry' && ev.subtype === 'user_message' && typeof ev.ts === 'string') messageTimes.push(ev.ts)

  let partials = new Map<string, { model?: string; usage: TokenUsage }>()
  const close = (ok: boolean, share: TurnShare | null, signal?: TurnEndSignal) => {
    if (!share && !signal) {
      // The turn never ended: what the CLI reported per request until then.
      const p = partialShare(partials.values(), model)
      if (p) {
        share = { ...p.share, counters }
        counters = { ...counters, interrupted: p.interrupted }
      }
    }
    partials = new Map()
    const start = startedAt ?? run.createdAt
    const nextMessage = messageTimes[turn] ?? run.updatedAt
    const gap = Math.max(0, Date.parse(nextMessage) - Date.parse(start))
    const activeMs = signal?.durationMs ?? Math.min(gap, 3_600_000)
    const apiMs = signal?.apiMs
    const cliModel = signal?.model
    const m = share ? turnModel(share, cliModel ?? model) : (cliModel ?? model)
    metrics.push(
      turnMetrics(
        {
          turn: Math.max(turn, 1),
          startedAt: start,
          endedAt: new Date(Date.parse(start) + (Number.isFinite(activeMs) ? activeMs : 0)).toISOString(),
          activeMs: Number.isFinite(activeMs) ? activeMs : 0,
          ...(apiMs !== undefined ? { apiMs } : {}),
          model: m,
          ok,
          ...(!signal ? { usageIncomplete: true as const } : {})
        },
        share,
        table
      )
    )
    if (m) model = m
    open = false
  }

  for (const ev of events) {
    if (!isObj(ev)) continue
    if (ev.type === 'huntgry') {
      if (ev.subtype === 'user_message') {
        // The previous turn never ended (the process died): it still took time.
        if (open) close(false, null)
        turn++
        startedAt = typeof ev.ts === 'string' ? ev.ts : null
        open = true
      }
      continue
    }
    const signal = adapter.signal(ev)
    if (signal.type === 'init' && signal.model) model = signal.model
    if (signal.type === 'keep' && signal.partial) partials.set(signal.partial.key, signal.partial)
    if (signal.type !== 'turn-end') continue
    const share = turnShare(signal, counters, signal.model ?? model)
    counters = share.counters
    close(!signal.error, share, signal)
  }
  if (open && turn > 0) close(false, null)
  return { metrics, counters, model }
}

/**
 * What an interrupted turn used, from the per-request usage the CLI reported before it stopped
 * (Claude), deduplicated by request: a lower bound (output is only what was streamed so far).
 * `null` when nothing was reported. `interrupted` goes into the counters (see `CliCounters`).
 */
export function partialShare(
  parts: Iterable<{ model?: string; usage: TokenUsage }>,
  fallbackModel: string | null
): { share: Omit<TurnShare, 'counters'>; interrupted: Record<string, TokenUsage> } | null {
  const byModel = new Map<string, TokenUsage>()
  for (const p of parts) {
    const key = p.model ?? fallbackModel ?? ''
    byModel.set(key, addUsage(byModel.get(key) ?? { ...ZERO_USAGE }, p.usage))
  }
  const usage = [...byModel.values()].reduce((a, u) => addUsage(a, u), { ...ZERO_USAGE })
  if (totalTokens(usage) === 0) return null
  const named = [...byModel].filter(([m]) => m)
  return {
    share: { usage, ...(named.length > 0 ? { models: named.map(([model, u]) => ({ model, usage: u })) } : {}) },
    interrupted: Object.fromEntries(byModel)
  }
}
