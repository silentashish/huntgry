import type { ModelTurnUsage, RunSummary, RunTotals, TokenUsage, TurnMetrics } from './runner-types'

/**
 * API prices per model and the cost estimate of a turn (#44). Prices are USD per 1M tokens.
 * Every figure was read from the provider's official pricing page on `asOf`; a model whose
 * price could not be confirmed there is left out, so its turns read "not priced" (`null`),
 * never $0. The user can override or add models in Settings → Pricing.
 *
 * The estimate is what the tokens would cost at standard (global, non-batch, non-fast)
 * API rates and at the short-context tier: on a subscription (Claude Pro/Max, ChatGPT,
 * Google AI) nothing is billed per token.
 */

export interface ModelPrice {
  /** Canonical model id, e.g. `claude-opus-5-5`, `gpt-6-sol`, `gemini-3.8-flash`. */
  id: string
  label: string
  /** Other names that mean this model (agy's display names normalized, preview ids). */
  aliases?: string[]
  input: number
  /** Cache read (hit). */
  cachedInput: number
  /** Cache write (Claude: the 5-minute cache). Absent = billed as plain input. */
  cacheWrite?: number
  /** Claude's 1-hour cache write. Absent = `cacheWrite`. */
  cacheWrite1h?: number
  /** Output, reasoning included. */
  output: number
  /** Where the figures come from. */
  source: string
  /** Date (YYYY-MM-DD) the figures were read. */
  asOf: string
  /** Set on prices the user edited or added in Settings. */
  custom?: true
}

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OPENAI = 'https://developers.openai.com/api/docs/pricing'
const GOOGLE = 'https://ai.google.dev/gemini-api/docs/pricing'
const AS_OF = '2026-10-06'

/** Claude: 5m write = 1.25× input, 1h write = 2× input (the docs' table, checked per model). */
function claude(id: string, label: string, input: number, cachedInput: number, output: number, aliases?: string[]): ModelPrice {
  return {
    id,
    label,
    ...(aliases ? { aliases } : {}),
    input,
    cachedInput,
    cacheWrite: input * 1.25,
    cacheWrite1h: input * 2,
    output,
    source: ANTHROPIC,
    asOf: AS_OF
  }
}

function openai(id: string, label: string, input: number, cachedInput: number, output: number, cacheWrite?: number): ModelPrice {
  return { id, label, input, cachedInput, ...(cacheWrite !== undefined ? { cacheWrite } : {}), output, source: OPENAI, asOf: AS_OF }
}

/** Gemini has no cache-write charge (storage is billed per hour, not per token): writes cost plain input. */
function gemini(id: string, label: string, input: number, cachedInput: number, output: number, aliases?: string[]): ModelPrice {
  return { id, label, ...(aliases ? { aliases } : {}), input, cachedInput, output, source: GOOGLE, asOf: AS_OF }
}

/** The bundled table. Long-context tiers (>200k / >272k input per request) are not modelled: see the doc. */
export const MODEL_PRICES: readonly ModelPrice[] = [
  claude('claude-fable-5-1', 'Claude Fable 5.1', 10, 0.25, 50),
  claude('claude-fable-5', 'Claude Fable 5', 10, 1, 50),
  claude('claude-opus-5-5', 'Claude Opus 5.5', 4, 0.2, 20),
  claude('claude-opus-5', 'Claude Opus 5', 5, 0.5, 25),
  claude('claude-opus-4-8', 'Claude Opus 4.8', 5, 0.5, 25),
  claude('claude-opus-4-7', 'Claude Opus 4.7', 5, 0.5, 25),
  claude('claude-opus-4-6', 'Claude Opus 4.6', 5, 0.5, 25),
  claude('claude-opus-4-5', 'Claude Opus 4.5', 5, 0.5, 25),
  claude('claude-opus-4-1', 'Claude Opus 4.1', 15, 1.5, 75),
  claude('claude-opus-4', 'Claude Opus 4', 15, 1.5, 75),
  claude('claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 0.2, 10),
  claude('claude-sonnet-5', 'Claude Sonnet 5', 2, 0.2, 10),
  claude('claude-sonnet-4-6', 'Claude Sonnet 4.6', 3, 0.3, 15),
  claude('claude-sonnet-4-5', 'Claude Sonnet 4.5', 3, 0.3, 15),
  claude('claude-sonnet-4', 'Claude Sonnet 4', 3, 0.3, 15),
  claude('claude-haiku-4-5', 'Claude Haiku 4.5', 1, 0.1, 5),
  claude('claude-3-5-haiku', 'Claude Haiku 3.5', 0.8, 0.08, 4, ['claude-haiku-3-5']),
  openai('gpt-6-astra', 'GPT-6 Astra', 10, 1, 50, 12.5),
  openai('gpt-6.1-sol', 'GPT-6.1 Sol', 2, 0.1, 10, 2.5),
  openai('gpt-6-sol', 'GPT-6 Sol', 2, 0.2, 10, 2.5),
  openai('gpt-6-luna', 'GPT-6 Luna', 0.1, 0.01, 0.5, 0.125),
  openai('gpt-5.6-sol', 'GPT-5.6 Sol', 4, 0.4, 20, 5),
  openai('gpt-5.3-codex', 'GPT-5.3 Codex', 1.75, 0.175, 14),
  openai('gpt-5', 'GPT-5', 1.25, 0.125, 10),
  openai('gpt-5-mini', 'GPT-5 mini', 0.25, 0.025, 2),
  openai('o3', 'o3', 2, 0.5, 8),
  gemini('gemini-3.8-flash', 'Gemini 3.8 Flash', 0.75, 0.075, 3.75),
  gemini('gemini-3.7-flash', 'Gemini 3.7 Flash', 0.75, 0.075, 3.75),
  gemini('gemini-3.6-flash', 'Gemini 3.6 Flash', 0.75, 0.075, 3.75),
  gemini('gemini-3.5-flash', 'Gemini 3.5 Flash', 1.5, 0.15, 9),
  gemini('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 0.3, 0.03, 2.5),
  gemini('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 0.25, 0.025, 1.5),
  gemini('gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 2, 0.2, 12, ['gemini-3.1-pro']),
  gemini('gemini-2.5-pro', 'Gemini 2.5 Pro', 1.25, 0.125, 10),
  gemini('gemini-2.5-flash', 'Gemini 2.5 Flash', 0.3, 0.03, 2.5),
  gemini('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 0.1, 0.01, 0.4)
]

/** Prices the user changed or added (Settings → Pricing), stored in the app settings. */
export interface PricingOverrides {
  models: ModelPrice[]
}

/** The bundled table with the user's entries replacing same-id ones and added at the end. */
export function effectivePrices(overrides?: PricingOverrides | null): ModelPrice[] {
  const custom = new Map((overrides?.models ?? []).map((m) => [m.id, { ...m, custom: true as const }]))
  const merged = MODEL_PRICES.map((m) => custom.get(m.id) ?? m)
  for (const m of custom.values()) if (!MODEL_PRICES.some((b) => b.id === m.id)) merged.push(m)
  return merged
}

/**
 * The comparable form of a model name: lower case, no `[1m]` context tag, no date suffix
 * (`-20251001`, `-2026-05-01`), and agy's display names (`Claude Opus 4.6 (Thinking)`) turned
 * into ids (`claude-opus-4-6`).
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase()
  m = m.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim()
  m = m.replace(/\s+/g, '-')
  // Bedrock/Vertex spellings: `anthropic.claude-…-v1:0`, `claude-…@20251001`.
  m = m.replace(/^(?:[a-z]+\.)?(?=claude-)/, '').replace(/@\d{8}$/, '').replace(/-v\d+(?::\d+)?$/, '')
  m = m.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
  // Claude ids spell versions with dashes (`claude-opus-4-6`); display names use dots.
  if (m.startsWith('claude-')) m = m.replace(/(\d)\.(\d)/g, '$1-$2')
  return m
}

/**
 * The price of `model`, or `null` when none fits. Exact id or alias first; otherwise the longest
 * id the name extends with a non-version suffix (`gpt-6-sol-high` → `gpt-6-sol`, but
 * `claude-opus-5-6` never falls back to `claude-opus-5`).
 */
export function findPrice(model: string | null | undefined, table: readonly ModelPrice[] = MODEL_PRICES): ModelPrice | null {
  if (!model) return null
  const key = normalizeModelId(model)
  if (!key) return null
  const names = (p: ModelPrice) => [p.id, ...(p.aliases ?? [])].map(normalizeModelId)
  const exact = table.find((p) => names(p).includes(key))
  if (exact) return exact
  let best: { price: ModelPrice; len: number } | null = null
  for (const p of table) {
    for (const n of names(p)) {
      if (!key.startsWith(`${n}-`) || /\d/.test(key[n.length + 1] ?? '')) continue
      if (!best || n.length > best.len) best = { price: p, len: n.length }
    }
  }
  return best?.price ?? null
}

const PER_TOKEN = 1 / 1_000_000

/** What `usage` costs at `price`. Reasoning is inside `outputTokens`, so it is not added again. */
export function costAt(price: ModelPrice, u: TokenUsage): number {
  const write = price.cacheWrite ?? price.input
  const write1h = Math.min(u.cacheWrite1hTokens ?? 0, u.cacheWriteTokens)
  return (
    (u.inputTokens * price.input +
      u.cacheReadTokens * price.cachedInput +
      (u.cacheWriteTokens - write1h) * write +
      write1h * (price.cacheWrite1h ?? write) +
      u.outputTokens * price.output) *
    PER_TOKEN
  )
}

/** Estimated API cost of `usage` on `model`; `null` (never 0) when the model is unknown or not priced. */
export function estimateCost(
  model: string | null | undefined,
  usage: TokenUsage,
  table: readonly ModelPrice[] = MODEL_PRICES
): number | null {
  const price = findPrice(model, table)
  return price ? costAt(price, usage) : null
}

/**
 * A turn's estimate: per model when the CLI split it (all of them must be priced), else on the
 * turn's model. A turn that used no tokens costs 0 whatever the model.
 */
export function estimateTurn(
  turn: Pick<TurnMetrics, 'model' | 'usage' | 'models'>,
  table: readonly ModelPrice[] = MODEL_PRICES
): number | null {
  if (totalTokens(turn.usage) === 0) return 0
  if (turn.models && turn.models.length > 0) {
    let sum = 0
    for (const m of turn.models as ModelTurnUsage[]) {
      if (totalTokens(m.usage) === 0) continue
      const c = estimateCost(m.model, m.usage, table)
      if (c === null) return null
      sum += c
    }
    return sum
  }
  return estimateCost(turn.model, turn.usage, table)
}

export const ZERO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0
}) as TokenUsage

/** Everything billed: input, cache reads and writes, output. */
export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const h = (a.cacheWrite1hTokens ?? 0) + (b.cacheWrite1hTokens ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(h > 0 ? { cacheWrite1hTokens: h } : {}),
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens
  }
}

/** Sums of a run's turns. */
export function runTotals(metrics: readonly TurnMetrics[]): RunTotals {
  let usage: TokenUsage = { ...ZERO_USAGE }
  let activeMs = 0
  let cost = 0
  let priced = 0
  let reported: number | undefined
  for (const t of metrics) {
    usage = addUsage(usage, t.usage)
    activeMs += t.activeMs
    if (t.estimatedCostUsd === null) continue
    cost += t.estimatedCostUsd
    priced++
  }
  for (const t of metrics) if (t.reportedCostUsd !== undefined) reported = (reported ?? 0) + t.reportedCostUsd
  return {
    turns: metrics.length,
    activeMs,
    usage,
    estimatedCostUsd: cost,
    pricedTurns: priced,
    unpricedTurns: metrics.length - priced,
    ...(reported !== undefined ? { reportedCostUsd: reported } : {})
  }
}

/**
 * The run with every turn's estimate recomputed at `table` and its totals rebuilt: stored
 * tokens are raw, so a price change in Settings reprices old runs without re-running them.
 */
export function priceRun<R extends Pick<RunSummary, 'metrics' | 'totals'>>(run: R, table: readonly ModelPrice[]): R {
  if (!run.metrics) return run
  const metrics = run.metrics.map((t) => ({ ...t, estimatedCostUsd: estimateTurn(t, table) }))
  return { ...run, metrics, totals: runTotals(metrics) }
}

/** Checks a price entry from the renderer (Settings → Pricing). */
export function requireModelPrice(input: unknown): ModelPrice {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid price.')
  const p = input as Record<string, unknown>
  const id = typeof p.id === 'string' ? p.id.trim() : ''
  if (!/^[\w.:/@ ()[\]-]{1,120}$/.test(id)) throw new Error('Enter a model id (letters, digits, - . _ : /).')
  const rate = (v: unknown, name: string, optional = false): number | undefined => {
    if (optional && (v === undefined || v === null || v === '')) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000) throw new Error(`Enter a valid ${name} price.`)
    return v
  }
  const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 120) : id
  const source = typeof p.source === 'string' && p.source.trim() ? p.source.trim().slice(0, 500) : 'Set in Settings'
  const asOf = typeof p.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf) ? p.asOf : new Date().toISOString().slice(0, 10)
  const aliases = Array.isArray(p.aliases) ? p.aliases.filter((a): a is string => typeof a === 'string' && !!a.trim()).slice(0, 10) : []
  const cacheWrite = rate(p.cacheWrite, 'cache write', true)
  const cacheWrite1h = rate(p.cacheWrite1h, '1-hour cache write', true)
  return {
    id,
    label,
    ...(aliases.length ? { aliases } : {}),
    input: rate(p.input, 'input')!,
    cachedInput: rate(p.cachedInput, 'cached input')!,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
    output: rate(p.output, 'output')!,
    source,
    asOf
  }
}
