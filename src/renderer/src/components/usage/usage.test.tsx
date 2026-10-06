import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it } from 'vitest'
import { runTotals } from '@shared/pricing'
import type { RunSummary, TurnMetrics } from '@shared/runner-types'
import { RunList } from '../../pages/tailor/RunList'
import { Transcript } from '../../pages/tailor/Transcript'
import { formatCost, formatDuration, formatTokens, formatTotalCost, runBadge, turnFooter, waitingMs } from './format'
import { RunMetrics } from './RunMetrics'

const turn = (over: Partial<TurnMetrics>): TurnMetrics => ({
  turn: 1,
  startedAt: '2026-10-01T09:00:00.000Z',
  endedAt: '2026-10-01T09:02:14.000Z',
  activeMs: 134_000,
  model: 'claude-haiku-4-5-20251001',
  usage: { inputTokens: 18, cacheReadTokens: 32976, cacheWriteTokens: 10782, outputTokens: 209, reasoningTokens: 82 },
  estimatedCostUsd: 0.0259246,
  ok: true,
  ...over
})

const run = (metrics: TurnMetrics[], over: Partial<RunSummary> = {}): RunSummary => ({
  id: '20261001-090000-abcdef',
  title: 'Staff Engineer · Acme',
  params: { coverLetter: false, dateStyle: 'right' },
  agent: 'claude',
  status: 'finished',
  sessionId: 's',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  outputFolder: null,
  outputFiles: [],
  costUsd: 0,
  live: false,
  model: 'claude-haiku-4-5-20251001',
  metrics,
  totals: runTotals(metrics),
  ...over
})

const html = (node: React.ReactNode) => renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>)

describe('usage formatting (#44)', () => {
  it('formats time, tokens and cost the same way for every agent', () => {
    expect(formatDuration(14_400)).toBe('14s')
    expect(formatDuration(134_000)).toBe('2m 14s')
    expect(formatDuration(3_900_000)).toBe('1h 05m')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(48_210)).toBe('48.2k')
    expect(formatTokens(480_000)).toBe('480k')
    expect(formatTokens(1_234_567)).toBe('1.23M')
    expect(formatCost(null)).toBe('not priced')
    expect(formatCost(0.31)).toBe('$0.31')
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatTotalCost({ estimatedCostUsd: 0, unpricedTurns: 2, pricedTurns: 0 })).toBe('not priced')
    expect(formatTotalCost({ estimatedCostUsd: 0.5, unpricedTurns: 1, pricedTurns: 3 })).toBe('≥ $0.50')
  })

  it('builds the row badge and the turn footer from the metrics', () => {
    const r = run([turn({}), turn({ turn: 2, activeMs: 1000, estimatedCostUsd: 0.31 })])
    expect(runBadge(r)).toBe('2m 15s · 88.0k tok · $0.34')
    expect(runBadge(run([]))).toBeNull()
    expect(runBadge({ totals: undefined })).toBeNull()
    expect(turnFooter(turn({}))).toBe('2m 14s · 18 in · 33.0k cached · 10.8k cache write · 209 out (82 reasoning) · $0.03')
    expect(waitingMs(r)).toBe(3_600_000 - 135_000)
  })

  it('shows the metrics strip on the run page and the badge in the run list', () => {
    const r = run([turn({}), turn({ turn: 2, model: null, estimatedCostUsd: null })])
    const strip = html(<RunMetrics run={r} />)
    expect(strip).toContain('Active time')
    expect(strip).toContain('4m 28s')
    expect(strip).toContain('claude-haiku-4-5-20251001')
    expect(strip).toContain('≥ $0.03')
    const list = html(<RunList runs={[r]} selected={null} onSelect={() => undefined} />)
    expect(list).toContain('data-testid="run-usage"')
    expect(list).toContain('4m 28s · 88.0k tok · ≥ $0.03')
  })

  it('the transcript footer of a turn reads its metrics, and falls back to the CLI figure', () => {
    const items = [
      { kind: 'result' as const, id: 'r1', ok: true, text: 'done', costUsd: 0.0259, durationMs: 3724, denials: [], turn: 1 },
      { kind: 'result' as const, id: 'r2', ok: true, text: 'done', costUsd: 0.5, durationMs: 0, denials: [], turn: 2 }
    ]
    const out = html(<Transcript items={items} metrics={[turn({})]} />)
    expect(out).toContain('Turn finished · 2m 14s · 18 in')
    expect(out).toContain('Turn finished · $0.50')
  })
})
