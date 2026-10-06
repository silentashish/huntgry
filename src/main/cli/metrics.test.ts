import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  costAt,
  effectivePrices,
  estimateCost,
  estimateTurn,
  findPrice,
  MODEL_PRICES,
  normalizeModelId,
  priceRun,
  requireModelPrice,
  runTotals,
  totalTokens
} from '@shared/pricing'
import type { RunSummary, TokenUsage, TurnMetrics } from '@shared/runner-types'
import { summarizeUsage, usageCsv, USAGE_CSV_HEADER } from '@shared/usage'
import { AGENTS } from './agents'
import { agyUsage } from './agents/antigravity'
import { claudeUsage } from './agents/claude'
import { codexUsage } from './agents/codex'
import type { TurnEndSignal } from './agents/types'
import { backfillMetrics, turnShare } from './metrics'
import { listRuns } from './runs'
import { usageSummary, withMetrics, withPrices } from './usage'

const FIXTURES = join(__dirname, 'fixtures')

async function jsonl(name: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(FIXTURES, name), 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const usage = (p: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  ...p
})

describe('adapters normalize the CLI usage of the recorded fixtures (#44)', () => {
  it('Claude: per-turn usage with cache split and thinking, the model, and an estimate equal to costUSD', async () => {
    const events = await jsonl('read-file-turn.jsonl')
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init')!
    expect(AGENTS.claude.signal(init)).toEqual({
      type: 'init',
      sessionId: '9a7079b6-ee19-44e5-b34c-6dcaca281b66',
      model: 'claude-haiku-4-5-20251001'
    })
    const result = events.find((e) => e.type === 'result')!
    const signal = AGENTS.claude.signal(result) as TurnEndSignal
    expect(signal).toMatchObject({
      type: 'turn-end',
      costUsd: 0.0259246,
      usageScope: 'turn',
      apiMs: 3407,
      durationMs: 3724,
      usage: usage({
        inputTokens: 18,
        cacheReadTokens: 32976,
        cacheWriteTokens: 10782,
        cacheWrite1hTokens: 10782,
        outputTokens: 209,
        reasoningTokens: 82
      })
    })
    expect(Object.keys(signal.models!)).toEqual(['claude-haiku-4-5-20251001'])
    // The table prices the turn exactly as the CLI did (Claude Code writes the 1-hour cache).
    const estimate = estimateCost('claude-haiku-4-5-20251001', signal.usage!)
    expect(estimate).toBeCloseTo(0.0259246, 9)
    const share = turnShare(signal, undefined, 'claude-haiku-4-5-20251001')
    expect(share.reportedCostUsd).toBeCloseTo(0.0259246, 9)
    expect(estimateTurn({ model: 'claude-haiku-4-5-20251001', usage: share.usage, models: share.models })).toBeCloseTo(0.0259246, 9)
  })

  it('Codex: input_tokens include the cached ones, reasoning is part of the output', async () => {
    const done = (await jsonl('codex-turn.jsonl')).find((e) => e.type === 'turn.completed')!
    const signal = AGENTS.codex.signal(done) as TurnEndSignal
    expect(signal.usageScope).toBe('session')
    expect(signal.usage).toEqual(usage({ inputTokens: 46909 - 40704, cacheReadTokens: 40704, outputTokens: 119 }))
    expect(codexUsage({ input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 30, output_tokens: 9, reasoning_output_tokens: 4 })).toEqual(
      usage({ inputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 30, outputTokens: 9, reasoningTokens: 4 })
    )
  })

  it('Antigravity: thinking is billed on top of the output, the cache is inside the input', async () => {
    const result = (await jsonl('agy-turn.jsonl')).find((e) => e.event === 'result')!
    expect(AGENTS.antigravity.signal(result)).toMatchObject({
      type: 'turn-end',
      usageScope: 'turn',
      durationMs: 7500,
      usage: usage({ inputTokens: 12345, outputTokens: 410, reasoningTokens: 10 })
    })
    expect(agyUsage({ input_tokens: 1000, cache_read_tokens: 600, output_tokens: 5, thinking_tokens: 2 })).toEqual(
      usage({ inputTokens: 400, cacheReadTokens: 600, outputTokens: 7, reasoningTokens: 2 })
    )
    // A cache count larger than the input cannot be inside it.
    expect(agyUsage({ input_tokens: 10, cache_read_tokens: 600 })).toMatchObject({ inputTokens: 10, cacheReadTokens: 600 })
    expect(claudeUsage({})).toEqual({})
  })
})

describe('turnShare: running totals become per-turn shares', () => {
  it('Codex totals of a resumed thread (as recorded by a real run) give each turn its own tokens', () => {
    const totals = [
      { input_tokens: 89799, cached_input_tokens: 71680, output_tokens: 1641, reasoning_output_tokens: 23 },
      { input_tokens: 217129, cached_input_tokens: 174208, output_tokens: 4793, reasoning_output_tokens: 54 },
      { input_tokens: 293108, cached_input_tokens: 245760, output_tokens: 5034, reasoning_output_tokens: 73 }
    ]
    let counters
    const outputs: number[] = []
    for (const t of totals) {
      const share = turnShare(AGENTS.codex.signal({ type: 'turn.completed', usage: t }) as TurnEndSignal, counters, 'gpt-6.1-sol')
      counters = share.counters
      outputs.push(share.usage.outputTokens)
    }
    expect(outputs).toEqual([1641, 4793 - 1641, 5034 - 4793])
    expect(outputs.reduce((a, b) => a + b)).toBe(5034)
  })

  it('Claude: total_cost_usd and modelUsage are session totals; a resumed turn with no new work costs 0', () => {
    const first: TurnEndSignal = {
      type: 'turn-end',
      costUsd: 0.38,
      usage: usage({ inputTokens: 8, outputTokens: 5458 }),
      usageScope: 'turn',
      models: { 'claude-opus-5-5': { usage: usage({ inputTokens: 8, outputTokens: 5458 }), costUsd: 0.38 } }
    }
    const a = turnShare(first, undefined, 'claude-opus-5-5')
    expect(a.reportedCostUsd).toBe(0.38)
    const again = turnShare({ ...first, usage: usage({}) }, a.counters, 'claude-opus-5-5')
    expect(again.reportedCostUsd).toBe(0)
    expect(totalTokens(again.usage)).toBe(0)
    expect(again.models).toBeUndefined()
    // A sub-agent on another model shows up as its own share.
    const third = turnShare(
      {
        type: 'turn-end',
        costUsd: 0.5,
        usage: usage({ inputTokens: 2, outputTokens: 100, cacheWriteTokens: 50, cacheWrite1hTokens: 50 }),
        usageScope: 'turn',
        models: {
          'claude-opus-5-5': { usage: usage({ inputTokens: 10, outputTokens: 5558, cacheWriteTokens: 50 }), costUsd: 0.45 },
          'claude-haiku-4-5-20251001': { usage: usage({ inputTokens: 300, outputTokens: 40 }), costUsd: 0.05 }
        }
      },
      again.counters,
      'claude-opus-5-5'
    )
    expect(third.reportedCostUsd).toBeCloseTo(0.12)
    expect(third.models).toEqual([
      { model: 'claude-opus-5-5', usage: usage({ inputTokens: 2, outputTokens: 100, cacheWriteTokens: 50, cacheWrite1hTokens: 50 }), reportedCostUsd: expect.closeTo(0.07) },
      { model: 'claude-haiku-4-5-20251001', usage: usage({ inputTokens: 300, outputTokens: 40 }), reportedCostUsd: 0.05 }
    ])
    expect(third.usage).toMatchObject({ inputTokens: 302, outputTokens: 140, cacheWriteTokens: 50 })
  })

  it('a counter that went down means the CLI started again: the new value is the share', () => {
    const s = (input: number) => AGENTS.codex.signal({ type: 'turn.completed', usage: { input_tokens: input, output_tokens: 1 } }) as TurnEndSignal
    const a = turnShare(s(1000), undefined, null)
    const b = turnShare(s(300), a.counters, null)
    expect(b.usage.inputTokens).toBe(300)
  })
})

describe('pricing', () => {
  it('normalizes ids, dates, agy display names and cloud spellings', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModelId('Claude Opus 4.6 (Thinking)')).toBe('claude-opus-4-6')
    expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModelId('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('gpt-6-sol-2026-05-01')).toBe('gpt-6-sol')
    expect(findPrice('Claude Opus 4.6 (Thinking)')?.id).toBe('claude-opus-4-6')
    expect(findPrice('Gemini 3.1 Pro (High)')?.id).toBe('gemini-3.1-pro-preview')
    expect(findPrice('gpt-6.1-sol')?.id).toBe('gpt-6.1-sol')
    expect(findPrice('gpt-6-sol-high')?.id).toBe('gpt-6-sol')
  })

  it('never guesses a price: unknown versions and models are not priced (null, not 0)', () => {
    expect(findPrice('claude-opus-5-6')).toBeNull()
    expect(findPrice('gpt-7')).toBeNull()
    expect(findPrice(null)).toBeNull()
    expect(estimateCost('mystery-model', usage({ inputTokens: 1000 }))).toBeNull()
    expect(estimateCost('mystery-model', usage({}))).toBeNull()
    expect(estimateTurn({ model: null, usage: usage({ outputTokens: 1 }) })).toBeNull()
    expect(estimateTurn({ model: null, usage: usage({}) })).toBe(0)
  })

  it('prices each bucket at its rate; reasoning is not charged twice', () => {
    const opus = findPrice('claude-opus-5-5')!
    const u = usage({ inputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 2e6, cacheWrite1hTokens: 1e6, outputTokens: 1e6, reasoningTokens: 5e5 })
    expect(costAt(opus, u)).toBeCloseTo(4 + 0.2 + 5 + 8 + 20, 9)
    // Gemini has no cache-write rate: writes cost plain input.
    expect(costAt(findPrice('gemini-2.5-pro')!, usage({ cacheWriteTokens: 1e6 }))).toBeCloseTo(1.25, 9)
    for (const p of MODEL_PRICES) {
      expect(p.source).toMatch(/^https:\/\//)
      expect(p.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('applies Settings overrides and reprices stored turns without re-running', () => {
    const table = effectivePrices({ models: [{ ...findPrice('claude-haiku-4-5')!, input: 2 }, { ...requireModelPrice({ id: 'my-model', input: 1, cachedInput: 0, output: 1 }) }] })
    expect(table.find((p) => p.id === 'claude-haiku-4-5')).toMatchObject({ input: 2, custom: true })
    expect(findPrice('my-model', table)?.custom).toBe(true)
    const turn: TurnMetrics = {
      turn: 1,
      startedAt: '2026-10-01T00:00:00Z',
      endedAt: '2026-10-01T00:00:01Z',
      activeMs: 1000,
      model: 'my-model',
      usage: usage({ inputTokens: 1e6 }),
      estimatedCostUsd: null,
      ok: true
    }
    const priced = priceRun({ metrics: [turn], totals: undefined }, table)
    expect(priced.metrics![0].estimatedCostUsd).toBe(1)
    expect(priced.totals).toMatchObject({ estimatedCostUsd: 1, pricedTurns: 1, unpricedTurns: 0 })
    expect(priceRun({ metrics: [turn], totals: undefined }, MODEL_PRICES).totals).toMatchObject({ estimatedCostUsd: 0, pricedTurns: 0, unpricedTurns: 1 })
  })

  it('an edited bundled model keeps its aliases (agy names Gemini 3.1 Pro by its display name)', () => {
    const edited = requireModelPrice({ id: 'gemini-3.1-pro-preview', input: 3, cachedInput: 0.3, output: 15 })
    expect(edited.aliases).toBeUndefined()
    const table = effectivePrices({ models: [edited] })
    const price = findPrice('Gemini 3.1 Pro (High)', table)
    expect(price).toMatchObject({ id: 'gemini-3.1-pro-preview', input: 3, custom: true })
    const turn = { model: 'Gemini 3.1 Pro (High)', usage: usage({ inputTokens: 1e6 }) }
    expect(estimateTurn(turn, table)).toBe(3)
  })

  it('checks prices from the renderer', () => {
    expect(() => requireModelPrice({ id: '', input: 1, cachedInput: 1, output: 1 })).toThrow(/model id/)
    expect(() => requireModelPrice({ id: 'm', input: -1, cachedInput: 1, output: 1 })).toThrow(/input/)
    expect(() => requireModelPrice({ id: 'm', input: 1, cachedInput: 1, output: Number.NaN })).toThrow(/output/)
    expect(requireModelPrice({ id: 'm', input: 1, cachedInput: 0.1, output: 2, cacheWrite: '' })).not.toHaveProperty('cacheWrite')
  })
})

describe('backfill from events.jsonl', () => {
  it('rebuilds a Claude run: per-turn shares of the session totals, time from the CLI', async () => {
    const events = await jsonl('usage-workspace/.huntgry/runs/20260920-100000-eeeeee/events.jsonl')
    const { metrics, model } = backfillMetrics(
      { agent: 'claude', createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:20:00.000Z' },
      events,
      null
    )
    expect(model).toBe('claude-haiku-4-5-20251001')
    expect(metrics).toHaveLength(2)
    expect(metrics.map((m) => m.turn)).toEqual([1, 2])
    expect(metrics.map((m) => m.reportedCostUsd)).toEqual([0.0259246, expect.closeTo(0.0259246, 9)])
    expect(metrics[0].activeMs).toBe(3724)
    for (const m of metrics) expect(m.estimatedCostUsd).toBeCloseTo(0.0259246, 9)
  })

  it('an interrupted Claude turn keeps the per-request usage (deduplicated), and the next turn does not count it again', async () => {
    const events = (await jsonl('read-file-turn.jsonl')).filter((e) => e.type !== 'result')
    const result = (await jsonl('read-file-turn.jsonl')).find((e) => e.type === 'result')!
    const H = 'claude-haiku-4-5-20251001'
    // Turn 1 is stopped before its result; turn 2 ends, and Claude's running totals still hold turn 1's requests.
    const second = JSON.parse(JSON.stringify(result)) as Record<string, any>
    second.usage = { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 244 }
    second.modelUsage[H] = { ...second.modelUsage[H], inputTokens: 18 + 5, outputTokens: 209 + 40, cacheReadInputTokens: 32976 + 1000, cacheCreationInputTokens: 10782 }
    const { metrics, counters } = backfillMetrics(
      { agent: 'claude', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z' },
      [
        { type: 'huntgry', subtype: 'user_message', text: 'go', ts: '2026-10-01T00:00:00Z' },
        ...events,
        { type: 'huntgry', subtype: 'user_message', text: 'go on', ts: '2026-10-01T00:05:00Z' },
        second
      ],
      null
    )
    expect(metrics[0]).toMatchObject({
      ok: false,
      usageIncomplete: true,
      model: H,
      // Each request counted once although Claude repeats its usage on every block: 10 + 8 input, 3 + 2 output.
      usage: { inputTokens: 18, cacheReadTokens: 32976, cacheWriteTokens: 10782, cacheWrite1hTokens: 10782, outputTokens: 5 }
    })
    expect(metrics[0].estimatedCostUsd).toBeGreaterThan(0)
    // Turn 2's share of the running totals, minus what turn 1 was already given.
    expect(metrics[1].usage).toMatchObject({ inputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 244 })
    expect(metrics[1].usageIncomplete).toBeUndefined()
    expect(counters.interrupted).toBeUndefined()
  })

  it('a turn that never ended (crash) still counts its time until the next message', () => {
    const { metrics } = backfillMetrics(
      { agent: 'codex', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T01:00:00Z' },
      [
        { type: 'huntgry', subtype: 'user_message', text: 'go', ts: '2026-10-01T00:00:00Z' },
        { type: 'huntgry', subtype: 'user_message', text: 'again', ts: '2026-10-01T00:02:00Z' },
        { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } }
      ],
      'gpt-6.1-sol'
    )
    expect(metrics.map((m) => [m.turn, m.ok, m.activeMs, m.usageIncomplete])).toEqual([
      [1, false, 120_000, true],
      [2, true, 3_480_000, undefined]
    ])
    expect(metrics[1].model).toBe('gpt-6.1-sol')
  })
})

describe('usage summary over fixture run.json files', () => {
  let ws: string
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'huntgry-usage-'))
    await cp(join(FIXTURES, 'usage-workspace'), ws, { recursive: true })
  })
  afterEach(() => rm(ws, { recursive: true, force: true }))

  const NOW = Date.parse('2026-10-06T12:00:00Z')

  it('totals equal the sum of the per-run numbers, and the breakdown adds up to them', async () => {
    const s = await usageSummary(ws, {}, () => null, NOW)
    expect(s.totals.runs).toBe(5)
    expect(s.runs).toHaveLength(5)
    const sum = (f: (r: (typeof s.runs)[number]) => number) => s.runs.reduce((a, r) => a + f(r), 0)
    expect(s.totals.activeMs).toBe(sum((r) => r.activeMs))
    expect(totalTokens(s.totals.usage)).toBe(sum((r) => totalTokens(r.usage)))
    expect(s.totals.usage.outputTokens).toBe(sum((r) => r.usage.outputTokens))
    expect(s.totals.estimatedCostUsd).toBeCloseTo(sum((r) => r.estimatedCostUsd ?? 0), 12)
    expect(s.totals.unpricedTurns).toBe(sum((r) => r.unpricedTurns))
    // The same totals per agent × model and per day.
    expect(s.byAgentModel.reduce((a, g) => a + g.estimatedCostUsd, 0)).toBeCloseTo(s.totals.estimatedCostUsd, 12)
    expect(s.byAgentModel.reduce((a, g) => a + g.activeMs, 0)).toBe(s.totals.activeMs)
    expect(s.byDay.reduce((a, d) => a + d.tokens, 0)).toBe(totalTokens(s.totals.usage))
    expect(s.totals.built).toBe(2)
    expect(s.totals.unpricedTurns).toBe(1)
    expect(s.byAgentModel.find((g) => g.agent === 'codex' && g.model === null)).toMatchObject({ runs: 1, unpricedTurns: 1 })
    // Failed runs cost money too, and are part of the total.
    const failed = s.runs.find((r) => r.status === 'failed')!
    expect(s.totals.failedCostUsd).toBeCloseTo(failed.estimatedCostUsd!, 12)
    expect(failed.estimatedCostUsd).toBeCloseTo((18095 * 2 + 71680 * 0.1 + 1641 * 10) / 1e6, 12)
  })

  it('each run reads the same numbers the Tailor page shows (run totals at the same prices)', async () => {
    const s = await usageSummary(ws, {}, () => null, NOW)
    for (const raw of await listRuns(ws)) {
      const run = withPrices(await withMetrics(ws, raw))
      const row = s.runs.find((r) => r.id === run.id)!
      expect(row.activeMs).toBe(run.totals!.activeMs)
      expect(row.usage).toEqual(run.totals!.usage)
      if (row.estimatedCostUsd !== null) expect(row.estimatedCostUsd).toBeCloseTo(run.totals!.estimatedCostUsd, 12)
    }
    const old = s.runs.find((r) => r.id === '20260920-100000-eeeeee')!
    expect(old).toMatchObject({ backfilled: true, turns: 2, reportedCostUsd: expect.closeTo(0.0518492, 9) })
    // The waiting time is the wall time minus the active time.
    const claude = s.runs.find((r) => r.id === '20261001-090000-aaaaaa')!
    expect(claude.activeMs).toBe(180_000)
    expect(claude.waitingMs).toBe(2 * 3600_000 - 180_000)
  })

  it('filters by date range, agent, model, status and batch; totals a batch', async () => {
    const week = await usageSummary(ws, { range: '7d' }, () => null, NOW)
    expect(week.runs.map((r) => r.id)).not.toContain('20260920-100000-eeeeee')
    expect(week.totals.runs).toBe(4)
    expect((await usageSummary(ws, { agents: ['codex'] }, () => null, NOW)).totals.runs).toBe(2)
    expect((await usageSummary(ws, { models: ['gpt-6.1-sol'] }, () => null, NOW)).runs.map((r) => r.id)).toEqual(['20261001-090001-bbbbbb'])
    expect((await usageSummary(ws, { statuses: ['finished'] }, () => null, NOW)).totals.runs).toBe(3)
    const all = await usageSummary(ws, {}, () => null, NOW)
    expect(all.models).toContain('Claude Opus 4.6 (Thinking)')
    expect(all.batches).toHaveLength(1)
    const batch = all.batches[0]
    expect(batch).toMatchObject({ batchId: 'b-20261001-085959-111111', runs: 2, built: 1, agents: ['claude', 'codex'] })
    const members = all.runs.filter((r) => r.batchId === batch.batchId)
    expect(batch.estimatedCostUsd).toBeCloseTo(members.reduce((a, r) => a + (r.estimatedCostUsd ?? 0), 0), 12)
    expect(batch.activeMs).toBe(members.reduce((a, r) => a + r.activeMs, 0))
    const only = await usageSummary(ws, { batchId: batch.batchId }, () => null, NOW)
    expect(only.totals.estimatedCostUsd).toBeCloseTo(batch.estimatedCostUsd, 12)
  })

  it('splits a turn with a sub-agent model into its models, without counting time twice; filters by the sub-agent model', () => {
    const OPUS = 'claude-opus-5-5'
    const HAIKU = 'claude-haiku-4-5-20251001'
    const opus = usage({ inputTokens: 1000, outputTokens: 500 })
    const haiku = usage({ inputTokens: 4000, outputTokens: 200 })
    const t: TurnMetrics = {
      turn: 1,
      startedAt: '2026-10-05T10:00:00.000Z',
      endedAt: '2026-10-05T10:01:00.000Z',
      activeMs: 60_000,
      model: OPUS,
      usage: usage({ inputTokens: 5000, outputTokens: 700 }),
      models: [
        { model: OPUS, usage: opus },
        { model: HAIKU, usage: haiku }
      ],
      estimatedCostUsd: null,
      ok: true
    }
    const run = priceRun(
      {
        id: '20261005-100000-abcdef',
        title: 'two models',
        params: { coverLetter: false, dateStyle: 'right' },
        agent: 'claude',
        status: 'finished',
        sessionId: null,
        createdAt: '2026-10-05T10:00:00.000Z',
        updatedAt: '2026-10-05T10:01:00.000Z',
        outputFolder: null,
        outputFiles: [],
        costUsd: 0,
        live: false,
        model: OPUS,
        metrics: [t]
      } as RunSummary,
      MODEL_PRICES
    )
    const s = summarizeUsage([run], {}, NOW)
    const opusCost = (1000 * 4 + 500 * 20) / 1e6
    const haikuCost = (4000 * 1 + 200 * 5) / 1e6
    expect(s.totals.estimatedCostUsd).toBeCloseTo(opusCost + haikuCost, 12)
    expect(s.byAgentModel.map((g) => [g.model, g.activeMs, g.usage.inputTokens])).toEqual([
      [OPUS, 60_000, 1000],
      [HAIKU, 0, 4000]
    ])
    expect(s.byAgentModel[0].estimatedCostUsd).toBeCloseTo(opusCost, 12)
    expect(s.byAgentModel[1].estimatedCostUsd).toBeCloseTo(haikuCost, 12)
    expect(s.byAgentModel.reduce((a, g) => a + g.activeMs, 0)).toBe(s.totals.activeMs)
    expect(s.byAgentModel.reduce((a, g) => a + totalTokens(g.usage), 0)).toBe(totalTokens(s.totals.usage))
    expect(s.models).toEqual([HAIKU, OPUS])
    expect(summarizeUsage([run], { models: [HAIKU] }, NOW).totals.runs).toBe(1)
  })

  it('waiting time: frozen while a turn runs, growing while the run waits', () => {
    const base = {
      id: '20261006-100000-abcdef',
      title: 'w',
      params: { coverLetter: false, dateStyle: 'right' as const },
      agent: 'claude' as const,
      sessionId: null,
      createdAt: '2026-10-06T10:00:00.000Z',
      updatedAt: '2026-10-06T10:00:00.000Z',
      outputFolder: null,
      outputFiles: [],
      costUsd: 0,
      live: true
    }
    const now = Date.parse('2026-10-06T10:05:00.000Z')
    // Five minutes into the first turn: nothing waited.
    expect(summarizeUsage([{ ...base, status: 'running', turnStartedAt: base.createdAt, metrics: [] }], {}, now).runs[0].waitingMs).toBe(0)
    // A 1-minute turn, a 3-minute wait for the reply, then a second turn running for a minute.
    const first: TurnMetrics = {
      turn: 1,
      startedAt: base.createdAt,
      endedAt: '2026-10-06T10:01:00.000Z',
      activeMs: 60_000,
      model: null,
      usage: usage({}),
      estimatedCostUsd: 0,
      ok: true
    }
    const resumed = { ...base, status: 'running' as const, turnStartedAt: '2026-10-06T10:04:00.000Z', metrics: [first] }
    expect(summarizeUsage([resumed], {}, now).runs[0].waitingMs).toBe(180_000)
    // Waiting now: until now.
    expect(summarizeUsage([{ ...base, status: 'waiting', metrics: [first] }], {}, now).runs[0].waitingMs).toBe(240_000)
  })

  it('a live run counts with its in-memory numbers', async () => {
    const live = (id: string): RunSummary | null =>
      id === '20261005-080000-dddddd'
        ? ({ ...JSON.parse('{}'), id, title: 'live', agent: 'codex', status: 'running', params: { coverLetter: false, dateStyle: 'right' }, createdAt: '2026-10-05T08:00:00.000Z', updatedAt: '2026-10-05T08:00:00.000Z', outputFolder: null, outputFiles: [], costUsd: 0, live: true, sessionId: null, metrics: [] } as RunSummary)
        : null
    const s = await usageSummary(ws, {}, live, NOW)
    expect(s.runs.find((r) => r.id === '20261005-080000-dddddd')).toMatchObject({ status: 'running', turns: 0 })
  })

  it('exports one CSV line per run, quoted and safe for spreadsheets', () => {
    const rows = summarizeUsage([], {}, NOW).runs
    expect(usageCsv(rows)).toBe(`${USAGE_CSV_HEADER.join(',')}\r\n`)
    const run: RunSummary = {
      id: '20261001-000000-abcdef',
      title: '=HYPERLINK("x"), "quoted"',
      params: { coverLetter: false, dateStyle: 'right' },
      agent: 'claude',
      status: 'finished',
      sessionId: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:01:00.000Z',
      outputFolder: null,
      outputFiles: [],
      costUsd: 0,
      live: false,
      metrics: [],
      totals: runTotals([])
    }
    const csv = usageCsv(summarizeUsage([run], {}, NOW).runs)
    expect(csv.split('\r\n')[1]).toMatch(/^20261001-000000-abcdef,2026-10-01T00:00:00.000Z,"'=HYPERLINK\(""x""\), ""quoted""",claude,/)
  })
})
