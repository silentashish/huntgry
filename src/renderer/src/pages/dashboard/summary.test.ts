import { describe, expect, it } from 'vitest'
import type { ApplicationRecord, ApplicationStatus } from '@shared/applications-types'
import type { RunSummary } from '@shared/runner-types'
import { summarizeUsage } from '@shared/usage'
import { buildBadgeOf } from './BuildBadge'
import { dayBars, dayKey, pipelineOutcome, usageHiddenFilters, firstNameOf, greetingFor, greetingLine, kpiSubs, listNames, needsYouLine, readyToApply } from './summary'

const rec = (company: string, status: ApplicationStatus, extra: Partial<ApplicationRecord> = {}, appliedAt?: string): ApplicationRecord => ({
  id: `eng/${company.toLowerCase()}/1`,
  role: 'Engineer',
  company,
  jobId: '1',
  jobTitle: `${company} engineer`,
  jobUrl: 'https://jobs.example.com/1',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  files: ['resume.pdf'],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  tracking: { status, notes: '', ...(appliedAt ? { appliedAt } : {}) },
  ...extra
})

describe('greeting', () => {
  it('follows the hour of the day', () => {
    expect(greetingFor(6)).toBe('Good morning')
    expect(greetingFor(11)).toBe('Good morning')
    expect(greetingFor(12)).toBe('Good afternoon')
    expect(greetingFor(19)).toBe('Good evening')
    expect(greetingFor(2)).toBe('Good evening')
  })

  it('uses the first name of the master profile, or none', () => {
    expect(firstNameOf('  Ashish Gautam ')).toBe('Ashish')
    expect(firstNameOf('')).toBeNull()
    expect(firstNameOf(undefined)).toBeNull()
    expect(greetingLine(new Date(2026, 9, 7, 9), 'Ashish Gautam')).toBe('Good morning, Ashish.')
    expect(greetingLine(new Date(2026, 9, 7, 15), '')).toBe('Good afternoon.')
  })

  it('counts the things that need the user, or says nothing does', () => {
    expect(needsYouLine(3)).toBe('3 things need you before the hunt moves on.')
    expect(needsYouLine(1)).toBe('1 thing needs you before the hunt moves on.')
    expect(needsYouLine(0)).toMatch(/^Nothing needs you/)
  })
})

describe('readyToApply', () => {
  it('keeps generated results with a resume, a posting and no review blocking them', () => {
    const apps = [
      rec('Acme', 'generated'),
      rec('Globex', 'applied'),
      rec('Umbrella', 'generated', { files: [] }),
      rec('Wayne', 'generated', { jobUrl: null }),
      rec('Initech', 'generated', { tracking: { status: 'generated', notes: '', review: { state: 'unreviewed', runId: 'r', at: '' } } }),
      rec('Stark', 'generated', { tracking: { status: 'generated', notes: '', review: { state: 'approved', runId: 'r', at: '' } } })
    ]
    expect(readyToApply(apps).map((a) => a.company)).toEqual(['Acme', 'Stark'])
  })
})

describe('listNames', () => {
  it('names one or two, then counts the rest', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['Stripe'])).toBe('Stripe')
    expect(listNames(['Stripe', 'Vercel', 'Stripe'])).toBe('Stripe and Vercel')
    expect(listNames(['Stripe', 'Vercel', 'Linear', 'Notion'])).toBe('Stripe, Vercel and 2 more')
  })
})

describe('kpiSubs', () => {
  it('says only what the records know', () => {
    const now = new Date('2026-10-05T12:00:00.000Z')
    const subs = kpiSubs(
      [
        rec('Acme', 'generated'),
        rec('Umbrella', 'generated', { files: [], createdAt: '2026-08-01T10:00:00.000Z' }),
        rec('Globex', 'applied', {}, '2026-10-02'),
        rec('Hooli', 'applied', {}, '2026-09-20'),
        rec('Vercel', 'offer')
      ],
      now
    )
    expect(subs.total).toBe('4 new this week')
    expect(subs.generated).toBe('1 resume built')
    expect(subs.applied).toBe('1 this month')
    expect(subs.offer).toBe('Vercel')
    expect(subs.interviewing).toBeUndefined()
    expect(subs.rejected).toBeUndefined()
  })
})

describe('dayBars', () => {
  const now = new Date(2026, 9, 7, 15)
  it('has one bar per calendar day from the day the totals start, empty days included, the last week marked', () => {
    const bars = dayBars([{ day: dayKey(new Date(2026, 9, 5)), tokens: 1000, estimatedCostUsd: 0.5, activeMs: 60_000 }], '30d', now)
    // now − 30 × 24 h falls on 7 Sep: 7 Sep … 7 Oct.
    expect(bars).toHaveLength(31)
    expect(bars[0].day).toBe('2026-09-07')
    expect(bars[30]).toMatchObject({ day: '2026-10-07', today: true, recent: true, costUsd: 0 })
    expect(bars[28]).toMatchObject({ day: '2026-10-05', costUsd: 0.5, tokens: 1000, recent: true, today: false })
    expect(bars[23].recent).toBe(false)
    expect(bars.filter((b) => b.recent)).toHaveLength(7)
    expect(dayBars([], '7d', now)).toHaveLength(8)
  })

  it('agrees with the usage totals: a run on the oldest day of the range keeps its bar', () => {
    const run = (createdAt: Date, cost: number) =>
      ({
        id: createdAt.toISOString(),
        title: 't',
        params: { coverLetter: false, dateStyle: 'right' },
        agent: 'claude',
        status: 'finished',
        sessionId: null,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
        outputFolder: null,
        outputFiles: [],
        costUsd: 0,
        live: false,
        metrics: [
          {
            turn: 1,
            startedAt: createdAt.toISOString(),
            endedAt: createdAt.toISOString(),
            activeMs: 1000,
            model: null,
            usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 },
            estimatedCostUsd: cost,
            ok: true
          }
        ]
      }) as RunSummary
    for (const range of ['7d', '30d'] as const) {
      const days = range === '7d' ? 7 : 30
      // An hour after the cutoff: inside the range, on the calendar day `days` days ago.
      const oldest = new Date(now.getTime() - days * 86_400_000 + 3600_000)
      const summary = summarizeUsage([run(oldest, 0.25), run(now, 1)], { range }, now.getTime())
      expect(summary.totals.runs).toBe(2)
      const bars = dayBars(summary.byDay, range, now)
      expect(bars[0].day).toBe(dayKey(oldest))
      expect(bars.reduce((sum, b) => sum + b.costUsd, 0)).toBeCloseTo(summary.totals.estimatedCostUsd, 6)
    }
  })

  it('starts "All time" at the first day with a turn, at most 60 days back', () => {
    expect(dayBars([], 'all', now)).toEqual([])
    expect(dayBars([{ day: '2026-10-03', tokens: 1, estimatedCostUsd: 0, activeMs: 0 }], 'all', now)).toHaveLength(5)
    expect(dayBars([{ day: '2025-01-01', tokens: 1, estimatedCostUsd: 0, activeMs: 0 }], 'all', now)).toHaveLength(60)
  })
})

describe('usageHiddenFilters', () => {
  it('counts the filters set behind Breakdown, not the header ones', () => {
    expect(usageHiddenFilters({ range: '30d' })).toBe(0)
    expect(usageHiddenFilters({ range: '7d', agents: ['claude'], batchId: 'b' })).toBe(0)
    expect(usageHiddenFilters({ models: ['m'], statuses: ['failed'], agents: ['claude', 'codex'] })).toBe(3)
  })
})

describe('pipelineOutcome', () => {
  const counts = (failed: number, total = 5) => ({ failed, total })
  it('names why the pipeline stopped, else how it finished', () => {
    expect(pipelineOutcome({ stopReason: 'Stopped by you.', counts: counts(0) })).toEqual({ label: 'Stopped by you', tone: 'neutral' })
    expect(pipelineOutcome({ stopReason: 'Claude reached its spend limit: monthly cap', counts: counts(0) })).toEqual({
      label: 'Paused: spend limit',
      tone: 'warning'
    })
    expect(pipelineOutcome({ stopReason: 'Budget reached: $5.00 of $5.00 spent.', counts: counts(0) }).label).toBe('Stopped: budget')
    expect(pipelineOutcome({ stopReason: 'Cannot start Codex: not found', counts: counts(0) })).toEqual({ label: 'Could not start', tone: 'danger' })
    expect(pipelineOutcome({ counts: counts(5) })).toEqual({ label: 'Failed', tone: 'danger' })
    expect(pipelineOutcome({ counts: counts(1) })).toEqual({ label: 'Finished · 1 failed', tone: 'warning' })
    expect(pipelineOutcome({ counts: counts(0) })).toEqual({ label: 'Finished', tone: 'success' })
  })
})

describe('buildBadgeOf', () => {
  it('reads the build report: passed (with warnings), failed, missing', () => {
    expect(buildBadgeOf({ status: 'pass', failed: [], warnings: 0, resumePages: 1 }, true)).toMatchObject({ tone: 'success', label: 'ATS passed' })
    expect(buildBadgeOf({ status: 'pass', failed: [], warnings: 2, resumePages: 1 }, true).label).toBe('ATS passed · 2 warnings')
    expect(buildBadgeOf({ status: 'pass', failed: [], warnings: 0, resumePages: 1 }, false).label).toBe('ATS checks passed')
    expect(buildBadgeOf({ status: 'fail', failed: ['one-page'], warnings: 0, resumePages: 2 }, false)).toMatchObject({
      tone: 'danger',
      label: 'Build failed: one-page'
    })
    expect(buildBadgeOf({ status: 'unknown', failed: [], warnings: 0, resumePages: null }, true)).toMatchObject({ tone: 'neutral', label: 'No report' })
  })
})
