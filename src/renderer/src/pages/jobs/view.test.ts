import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS } from '@shared/job-filters'
import { relevantJobs, scoreJob, type ProfileSignals, type ScoredJob } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'
import { defaultShow, scentView, visibleJobs } from './view'

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

const scored = (j: Job, score: number): ScoredJob => ({ job: j, score: { score, reasons: [], matched: true, match: { score: 0, matched: [], missing: [], gates: [], source: 'description' } } })

describe('Jobs page view', () => {
  const a = job('url:a', { remote: true })
  const b = job('url:b', { tailoredAt: '2026-10-01', description: 'US citizens only.' })
  const c = job('url:c', { dismissed: true })
  const jobs = [a, b, c]
  const base = { jobs, relevant: [scored(b, 90), scored(a, 50)], filters: DEFAULT_FILTERS, text: '', now: NOW }

  it('defaults to Relevant only when the profile has something to match on', () => {
    expect(defaultShow(true)).toBe('relevant')
    expect(defaultShow(false)).toBe('all')
  })

  it('lists each segment', () => {
    const ids = (show: Parameters<typeof visibleJobs>[0]['show']) => visibleJobs({ ...base, show }).map((j) => j.id)
    expect(ids('relevant')).toEqual(['url:b', 'url:a'])
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

  it('scores every saved job once and ranks Relevant from those scores exactly as relevantJobs does', () => {
    const signals: ProfileSignals = {
      titles: ['Backend Engineer'],
      skills: ['Go', 'PostgreSQL'],
      location: '',
      remote: true,
      needsSponsorship: true,
      years: 6
    }
    const at = (d: string) => `2026-10-0${d}T00:00:00Z`
    const saved = [
      // Asks for Kafka too, which the profile lacks: half the skills, so below url:pg (#149).
      job('url:go', { title: 'Backend Engineer', description: 'Go services on Kafka', remote: true, postedAt: at('5') }),
      job('url:pg', { title: 'Backend Engineer', description: 'Go and PostgreSQL', remote: true, postedAt: at('4') }),
      // Same score as url:go, newer: ranked first of the two.
      job('url:go2', { title: 'Backend Engineer', description: 'Go services on Kafka', remote: true, postedAt: at('6') }),
      job('url:novisa', { title: 'Backend Engineer', description: 'Go. We do not sponsor visas.', remote: true, postedAt: at('5') }),
      job('url:gone', { title: 'Backend Engineer', description: 'Go', remote: true, postedAt: at('5'), dismissed: true }),
      job('url:other', { title: 'Sales Manager', postedAt: at('5') })
    ]
    const { scores, relevant } = scentView(saved, signals, NOW)
    expect(relevant).toEqual(relevantJobs(saved, signals, NOW))
    expect(relevant.map((r) => r.job.id)).toEqual(['url:pg', 'url:go2', 'url:go'])
    // Every saved job has a score, including the ones Relevant leaves out, and Relevant reuses them.
    expect([...scores.keys()]).toEqual(saved.map((j) => j.id))
    for (const j of saved) expect(scores.get(j.id)).toEqual(scoreJob(j, signals, NOW))
    for (const r of relevant) expect(r.score).toBe(scores.get(r.job.id))
    expect(scores.get('url:novisa')?.excluded).toBe('Says it does not sponsor visas')
    expect(scentView(saved, { ...signals, titles: [] })).toEqual({ scores: new Map(), relevant: [] })
    expect(scentView(saved, null)).toEqual({ scores: new Map(), relevant: [] })
  })
})
