import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS } from '@shared/job-filters'
import type { ScoredJob } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'
import { since } from './labels'
import { defaultShow, visibleJobs } from './view'

const NOW = new Date('2026-10-06T12:00:00Z')

const job = (id: string, over: Partial<Job> = {}): Job =>
  ({
    id,
    title: id,
    company: 'Acme',
    location: '',
    tags: [],
    description: '',
    salary: '',
    remote: false,
    postedAt: null,
    ...over
  }) as Job

const scored = (j: Job, score: number): ScoredJob => ({ job: j, score: { score, reasons: [], matched: true } })

describe('Jobs page view', () => {
  const a = job('url:a', { remote: true })
  const b = job('url:b', { tailoredAt: '2026-10-01', description: 'US citizens only.' })
  const c = job('url:c', { dismissed: true })
  const jobs = [a, b, c]
  const base = { jobs, relevant: [scored(b, 90), scored(a, 50)], lastIds: new Set(['url:a']), filters: DEFAULT_FILTERS, text: '', now: NOW }

  it('defaults to Relevant only when the profile has something to match on', () => {
    expect(defaultShow(true)).toBe('relevant')
    expect(defaultShow(false)).toBe('all')
  })

  it('lists each segment', () => {
    const ids = (show: Parameters<typeof visibleJobs>[0]['show']) => visibleJobs({ ...base, show }).map((j) => j.id)
    expect(ids('relevant')).toEqual(['url:b', 'url:a'])
    expect(ids('search')).toEqual(['url:a'])
    expect(ids('all')).toEqual(['url:a', 'url:b'])
    expect(ids('new')).toEqual(['url:a'])
    expect(ids('tailored')).toEqual(['url:b'])
    expect(ids('dismissed')).toEqual(['url:c'])
  })

  it('applies the filters and the text box on top of any segment', () => {
    const hide = { ...DEFAULT_FILTERS, sponsorship: 'hide-no' as const }
    expect(visibleJobs({ ...base, show: 'relevant', filters: hide }).map((j) => j.id)).toEqual(['url:a'])
    const remote = { ...DEFAULT_FILTERS, workplace: ['Remote' as const] }
    expect(visibleJobs({ ...base, show: 'all', filters: remote }).map((j) => j.id)).toEqual(['url:a'])
    expect(visibleJobs({ ...base, show: 'all', text: 'URL:B' }).map((j) => j.id)).toEqual(['url:b'])
  })
})

describe('since', () => {
  it('says how long ago a refresh ran', () => {
    const t = NOW.getTime()
    expect(since(null, t)).toBe('never')
    expect(since(new Date(t - 20_000).toISOString(), t)).toBe('just now')
    expect(since(new Date(t - 5 * 60_000).toISOString(), t)).toBe('5 min ago')
    expect(since(new Date(t - 3 * 3_600_000).toISOString(), t)).toBe('3 h ago')
    expect(since(new Date(t - 30 * 3_600_000).toISOString(), t)).toBe('yesterday')
    expect(since(new Date(t - 72 * 3_600_000).toISOString(), t)).toBe('3 days ago')
  })
})
