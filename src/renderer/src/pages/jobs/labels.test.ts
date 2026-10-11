import { describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import { ago, jobFacts, jobMeta, sponsorshipPill, workplacePill } from './labels'

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'url:1',
    source: 'url',
    sourceId: '1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: '',
    remote: false,
    salary: '',
    postedAt: null,
    url: '',
    boardUrl: null,
    description: '',
    descriptionComplete: true,
    tags: [],
    fetchedAt: '2026-10-01T00:00:00Z',
    ...over
  }) as Job

describe('job labels', () => {
  it('ages a posting in days, then months', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    expect(ago(null, now)).toBe('')
    expect(ago('2026-10-11T08:00:00Z', now)).toBe('today')
    expect(ago('2026-10-10T08:00:00Z', now)).toBe('yesterday')
    expect(ago('2026-10-01T08:00:00Z', now)).toBe('10 days ago')
    expect(ago('2026-08-01T08:00:00Z', now)).toBe('2 months ago')
  })

  it('joins only the known parts of the meta line', () => {
    expect(jobMeta(job({ location: 'Denver, CO', salary: '$120k' }))).toBe('Acme · Denver, CO · $120k')
    expect(jobMeta(job())).toBe('Acme')
  })

  it('gives Remote the Trail tone and leaves an unknown workplace out', () => {
    expect(workplacePill(job({ remote: true }))).toEqual({ label: 'Remote', tone: 'trail' })
    expect(workplacePill(job({ workplaceType: 'Hybrid' }))).toEqual({ label: 'Hybrid', tone: 'neutral' })
    expect(workplacePill(job())).toBeNull()
  })

  it('says what the posting says about sponsorship, and nothing when it is silent', () => {
    expect(sponsorshipPill(job({ visaSponsorship: true }))).toEqual({ label: 'Sponsors visa', tone: 'review' })
    expect(sponsorshipPill(job({ description: 'We are unable to sponsor visas for this role.' }))).toEqual({
      label: 'No sponsorship',
      tone: 'warning'
    })
    expect(sponsorshipPill(job())).toBeNull()
  })

  it('lists the known facts of a job for the drawer', () => {
    expect(
      jobFacts(
        job({
          title: 'Senior Backend Engineer',
          remote: true,
          visaSponsorship: true,
          minYearsExperience: 5,
          commitment: ['Full Time'],
          salary: '$185k – $240k'
        })
      )
    ).toEqual([
      { label: 'Seniority', value: 'Senior' },
      { label: 'Workplace', value: 'Remote' },
      { label: 'Visa', value: 'Sponsors' },
      { label: 'Min. exp', value: '5 years' },
      { label: 'Commitment', value: 'Full Time' },
      { label: 'Salary', value: '$185k – $240k' }
    ])
    expect(jobFacts(job({ title: 'Engineer' }))).toEqual([])
  })
})
