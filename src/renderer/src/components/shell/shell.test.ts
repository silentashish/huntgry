import { describe, expect, it } from 'vitest'
import type { PipelineCounts, PipelineState } from '@shared/pipeline-types'
import { dollars, pipelineMini } from './pipelineMini'
import { runCounts, tailorBadge } from './counts'
import { versionLine } from './version'

const counts = (over: Partial<PipelineCounts> = {}): PipelineCounts => ({
  queued: 0,
  running: 0,
  needsReply: 0,
  unreviewed: 0,
  needsAttention: 0,
  approved: 0,
  discarded: 0,
  failed: 0,
  cancelled: 0,
  skipped: 0,
  total: 0,
  ...over
})

const state = (over: Partial<PipelineState> = {}): PipelineState =>
  ({
    id: 'p-1',
    status: 'running',
    counts: counts({ queued: 13, running: 2, unreviewed: 5, skipped: 2, total: 22 }),
    startedAt: '2026-10-07T10:00:00Z',
    etaMinutes: 39.6,
    costUsd: 3.2,
    budget: { maxCostUsd: 10 },
    startedJobs: 7,
    onBattery: false,
    keepAwake: true,
    warnings: [],
    interrupted: false,
    agent: 'claude',
    concurrency: 2,
    ...over
  }) as PipelineState

describe('sidebar pipeline card', () => {
  it('shows jobs done of jobs taken on, time left and spend against the budget (Figma 5:58)', () => {
    expect(pipelineMini(state())).toEqual({
      status: { label: 'Running', tone: 'trail' },
      done: 5,
      total: 20,
      percent: 25,
      facts: '5 of 20 jobs · ~40 min · $3.20 / $10'
    })
  })

  it('leaves out what it does not know, and the time left while not running', () => {
    expect(pipelineMini(state({ budget: undefined, costUsd: 0, etaMinutes: null }))?.facts).toBe('5 of 20 jobs')
    expect(pipelineMini(state({ status: 'paused' }))).toMatchObject({ status: { label: 'Paused', tone: 'warning' }, facts: '5 of 20 jobs · $3.20 / $10' })
    expect(pipelineMini(state({ budget: undefined }))?.facts).toBe('5 of 20 jobs · ~40 min · $3.20')
    expect(pipelineMini(state({ status: 'stopped-budget' }))?.status.tone).toBe('danger')
  })

  it('hides once the pipeline finished or when there is none', () => {
    expect(pipelineMini(null)).toBeNull()
    expect(pipelineMini(state({ status: 'finished' }))).toBeNull()
  })

  it('never divides by zero', () => {
    expect(pipelineMini(state({ counts: counts() }))).toMatchObject({ done: 0, total: 0, percent: 0 })
  })

  it('writes dollars like the design', () => {
    expect(dollars(10)).toBe('$10')
    expect(dollars(12.5)).toBe('$12.50')
  })
})

describe('sidebar badges', () => {
  it('counts runs waiting for a reply and working', () => {
    expect(runCounts(['waiting', 'running', 'finished', 'waiting', 'failed', 'stopped'])).toEqual({ waiting: 2, running: 1 })
  })

  it('labels the Tailor badge, and hides it with nothing live', () => {
    expect(tailorBadge({ waiting: 2, running: 1 })).toEqual({ count: 3, label: '2 waiting for your reply, 1 working' })
    expect(tailorBadge({ waiting: 0, running: 1 })).toEqual({ count: 1, label: '1 working' })
    expect(tailorBadge({ waiting: 0, running: 0 })).toBeNull()
  })
})

describe('version line', () => {
  it('shows major.minor like the Figma sidebar', () => {
    expect(versionLine('0.1.0')).toBe('v0.1 · the hound')
    expect(versionLine('1.12.3-beta.1')).toBe('v1.12 · the hound')
    expect(versionLine('')).toBe('the hound')
  })
})
