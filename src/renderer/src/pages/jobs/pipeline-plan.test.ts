import { describe, expect, it } from 'vitest'
import type { PipelinePlan, PipelineState } from '@shared/pipeline-types'
import { formatMinutes, formatUntil, planSummary, progress, statusLine } from './pipeline-plan'

const plan: PipelinePlan = {
  agent: 'claude',
  concurrency: 2,
  ready: [{ jobId: 'a', title: 'A' }, { jobId: 'b', title: 'B' }, { jobId: 'c', title: 'C' }],
  skipped: [{ jobId: 'd', title: 'D', reason: 'Indeed' }],
  blockers: [],
  warnings: [],
  estimateMinutes: 75,
  estimateCostUsd: 2.4,
  onBattery: false
}

const state = (over: Partial<PipelineState>): PipelineState => ({
  id: 'p',
  status: 'running',
  counts: { queued: 2, running: 1, needsReply: 0, unreviewed: 3, needsAttention: 1, failed: 0, cancelled: 0, skipped: 1, total: 8 },
  startedAt: '2026-09-30T00:00:00.000Z',
  etaMinutes: 12,
  costUsd: 1.5,
  startedJobs: 4,
  onBattery: false,
  keepAwake: true,
  warnings: [],
  interrupted: false,
  agent: 'claude',
  concurrency: 2,
  ...over
})

describe('pipeline plan helpers', () => {
  it('formats durations and reset times', () => {
    expect(formatMinutes(0)).toBe('under a minute')
    expect(formatMinutes(45)).toBe('45 min')
    expect(formatMinutes(120)).toBe('2 h')
    expect(formatMinutes(130)).toBe('2 h 10 min')
    const now = new Date(2026, 8, 30, 10, 0)
    expect(formatUntil(new Date(2026, 8, 30, 14, 5).toISOString(), now)).toMatch(/^until \d{1,2}:05/)
    expect(formatUntil(new Date(2026, 9, 1, 9, 0).toISOString(), now)).toMatch(/^until tomorrow /)
    expect(formatUntil(new Date(2026, 9, 5, 9, 0).toISOString(), now)).toMatch(/^until Mon /)
    expect(formatUntil('nope', now)).toBe('')
  })

  it('summarises a plan', () => {
    expect(planSummary(plan)).toEqual({
      ready: '3 jobs will run unattended, 2 at a time.',
      skipped: '1 skipped:',
      estimate: 'About 1 h 15 min.',
      cost: 'Roughly $2.40 (median of your recent unattended Claude runs).'
    })
    expect(planSummary({ ...plan, ready: [], estimateCostUsd: null }).ready).toBe('No job can run.')
    expect(planSummary({ ...plan, estimateCostUsd: null }).cost).toMatch(/No cost estimate yet/)
    expect(planSummary({ ...plan, agent: 'codex', estimateCostUsd: null }).cost).toBeNull()
  })

  it('writes the status line and the progress', () => {
    expect(statusLine(state({}))).toBe('Running · about 12 min left')
    expect(statusLine(state({ status: 'waiting-limit', limitAgent: 'claude', until: new Date(Date.now() + 60_000).toISOString() }))).toMatch(/^Waiting for Claude's limit · until .* · resumes by itself$/)
    expect(statusLine(state({ status: 'running', fallbackActive: true, limitAgent: 'claude', fallbackAgent: 'codex' }))).toBe('Running with Codex (Claude hit its limit)')
    expect(statusLine(state({ status: 'stopped-budget', stopReason: 'Budget reached: $40.00 of $40.00 spent.' }))).toBe('Stopped: budget reached · Budget reached: $40.00 of $40.00 spent.')
    expect(statusLine(state({ status: 'finished' }))).toBe('Finished')
    expect(progress(state({}))).toBe(57)
    expect(progress(state({ counts: { ...state({}).counts, total: 1, skipped: 1 } }))).toBe(0)
  })
})
