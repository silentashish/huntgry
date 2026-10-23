import { describe, expect, it } from 'vitest'
import type { ExploreJob } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import { addedJobs, dayGroups, dayLabel, defaultDay, updatedAgo, visibleRows } from './view'

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
})
