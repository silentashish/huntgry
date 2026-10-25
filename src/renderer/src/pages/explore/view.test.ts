import { describe, expect, it } from 'vitest'
import type { ExploreJob } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import {
  addedJobs,
  CATEGORY_STORAGE_KEY,
  categoryLabel,
  categoryOptions,
  dayGroups,
  dayLabel,
  defaultDay,
  effectiveFilters,
  NO_FILTERS,
  readCategory,
  readFlag,
  shortSalary,
  sourceLabel,
  splitDays,
  updatedAgo,
  visibleRows,
  writePref
} from './view'

const NOW = new Date(2026, 9, 21, 10, 0)
const row = (id: string, postedAt: string, extra: Partial<ExploreJob> = {}): ExploreJob => ({
  id,
  company: 'Rocket',
  companyUrl: null,
  title: 'Software Engineer',
  url: `https://jobright.ai/jobs/info/${id}`,
  location: 'Detroit, MI',
  workModel: 'On Site',
  postedAt,
  ...extra
})

const jobs = [
  row('aaaaaa1', '2026-10-20'),
  row('aaaaaa2', '2026-10-21', { company: 'Cadence', title: 'Application Engineer', workModel: 'Remote' }),
  row('aaaaaa3', '2026-10-21', { location: 'Austin, TX', workModel: 'Hybrid' }),
  row('aaaaaa4', '2026-10-14')
]

describe('Explore view', () => {
  it('groups by posted day, newest first, with counts', () => {
    expect(dayGroups(jobs)).toEqual([
      { day: '2026-10-21', count: 2 },
      { day: '2026-10-20', count: 1 },
      { day: '2026-10-14', count: 1 }
    ])
  })

  it('opens on today, or the newest day when today has none', () => {
    expect(defaultDay(dayGroups(jobs), NOW)).toBe('2026-10-21')
    expect(defaultDay(dayGroups(jobs.slice(0, 1)), NOW)).toBe('2026-10-20')
    expect(defaultDay([], NOW)).toBeNull()
  })

  it('labels days', () => {
    expect(dayLabel('2026-10-21', NOW)).toBe('Today')
    expect(dayLabel('2026-10-20', NOW)).toBe('Yesterday')
    expect(dayLabel('2026-10-14', NOW)).toBe('Oct 14')
    expect(dayLabel('2025-12-30', NOW)).toBe('Dec 30, 2025')
  })

  it('filters by day, text and work model', () => {
    const ids = (r: ExploreJob[]) => r.map((j) => j.id)
    expect(ids(visibleRows(jobs, { day: '2026-10-21', text: '', workModel: 'all' }))).toEqual(['aaaaaa2', 'aaaaaa3'])
    expect(ids(visibleRows(jobs, { day: '2026-10-21', text: 'cadence', workModel: 'all' }))).toEqual(['aaaaaa2'])
    expect(ids(visibleRows(jobs, { day: '2026-10-21', text: 'austin software', workModel: 'all' }))).toEqual(['aaaaaa3'])
    expect(ids(visibleRows(jobs, { day: '2026-10-21', text: '', workModel: 'Remote' }))).toEqual(['aaaaaa2'])
    expect(ids(visibleRows(jobs, { day: null, text: '', workModel: 'On Site' }))).toEqual(['aaaaaa1', 'aaaaaa4'])
  })

  it('knows which rows are already saved, also when merged into another board', () => {
    const saved = [
      { id: 'jobright:aaaaaa1' },
      { id: 'url:x', aliases: ['jobright:aaaaaa2'] },
      { id: 'pasted:y' }
    ] as Job[]
    const added = addedJobs(saved)
    expect(added.get('aaaaaa1')?.id).toBe('jobright:aaaaaa1')
    expect(added.get('aaaaaa2')?.id).toBe('url:x')
    expect(added.has('aaaaaa3')).toBe(false)
  })

  it('says when the list was updated', () => {
    const now = NOW.getTime()
    expect(updatedAgo(null, now)).toBe('Never updated')
    expect(updatedAgo(new Date(now - 20_000).toISOString(), now)).toBe('Updated just now')
    expect(updatedAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe('Updated 5 min ago')
    expect(updatedAgo(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('Updated 3 h ago')
    expect(updatedAgo(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('Updated 2 days ago')
  })

  it('folds the days past the newest seven', () => {
    const many = Array.from({ length: 10 }, (_, i) => row(`bbbbbb${i}`, `2026-10-${String(21 - i).padStart(2, '0')}`))
    const { recent, older } = splitDays(dayGroups(many))
    expect(recent.map((g) => g.day)).toEqual(['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16', '2026-10-15'])
    expect(older.map((g) => g.day)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12'])
    expect(splitDays(dayGroups(jobs)).older).toEqual([])
  })

  it('filters by H1B, minimum salary and industry (#169)', () => {
    const api = [
      row('cccccc1', '2026-10-21', { h1b: 'Yes', salary: '$150000-$168000/yr', industry: ['Gaming'] }),
      row('cccccc2', '2026-10-21', { h1b: 'No', salary: '$72000-$115000/yr' }),
      row('cccccc3', '2026-10-21', { h1b: 'Not Sure', salary: '$40-$55/hr' }),
      row('cccccc4', '2026-10-21')
    ]
    const ids = (f: Partial<typeof NO_FILTERS>) => visibleRows(api, { day: null, ...NO_FILTERS, ...f }).map((j) => j.id)
    expect(ids({})).toEqual(['cccccc1', 'cccccc2', 'cccccc3', 'cccccc4'])
    expect(ids({ h1b: 'yes' })).toEqual(['cccccc1'])
    expect(ids({ h1b: 'not-no' })).toEqual(['cccccc1', 'cccccc3', 'cccccc4'])
    // The top of the range must reach the minimum; hourly pay counts 2,080 hours; no pay text fails.
    expect(ids({ minSalary: 110000 })).toEqual(['cccccc1', 'cccccc2', 'cccccc3'])
    expect(ids({ minSalary: 116000 })).toEqual(['cccccc1'])
    expect(ids({ text: 'gaming' })).toEqual(['cccccc1'])
    expect(ids({ h1b: 'not-no', minSalary: 100000, workModel: 'On Site' })).toEqual(['cccccc1', 'cccccc3'])
  })

  it('turns off the filters a README list cannot answer', () => {
    const f = { ...NO_FILTERS, text: 'x', h1b: 'yes' as const, minSalary: 90000 }
    expect(effectiveFilters(f, 'readme')).toEqual({ ...f, h1b: 'all', minSalary: null })
    expect(effectiveFilters(f, 'api')).toBe(f)
  })

  it('remembers the category, ignoring anything it does not offer', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(readCategory(storage)).toBe('newgrad:us:swe')
    writePref(CATEGORY_STORAGE_KEY, 'intern:us:swe', storage)
    expect(readCategory(storage)).toBe('intern:us:swe')
    store.set(CATEGORY_STORAGE_KEY, 'newgrad:us:../../x')
    expect(readCategory(storage)).toBe('newgrad:us:swe')
    expect(readCategory(null)).toBe('newgrad:us:swe')
    const broken = { getItem: () => { throw new Error('denied') } }
    expect(readCategory(broken)).toBe('newgrad:us:swe')
    expect(readFlag('x', broken)).toBe(false)
  })

  it('labels categories and groups the picker', () => {
    expect(categoryLabel('newgrad:us:swe')).toBe('Software Engineering')
    expect(categoryLabel('newgrad:us:ml_ai')).toBe('Machine Learning & AI')
    const groups = categoryOptions()
    expect(groups.map((g) => g.group)).toEqual(['New grad · US', 'New grad · Canada', 'Internship · US', 'Internship · Canada'])
    expect(groups[0].items[0]).toEqual({ value: 'newgrad:us:swe', label: 'Software Engineering' })
  })

  it('says which source the list shows', () => {
    const jobs1000 = Array.from({ length: 1000 }, () => row('dddddd1', '2026-10-21'))
    expect(sourceLabel({ source: 'api', jobs: jobs1000, total: 2116 })).toBe('newgrad-jobs API · newest 1,000 of 2,116 jobs')
    expect(sourceLabel({ source: 'api', jobs: jobs.slice(0, 2), total: 2 })).toBe('newgrad-jobs API · 2 jobs')
    expect(sourceLabel({ source: 'readme', jobs })).toBe("Jobright's GitHub list (fallback) · 4 jobs")
  })

  it('shortens pay', () => {
    expect(shortSalary('$150000-$168000/yr')).toBe('$150k–$168k/yr')
    expect(shortSalary('$40-$55/hr')).toBe('$40–$55/hr')
  })
})
