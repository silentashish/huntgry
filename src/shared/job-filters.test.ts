import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  matchesFilters,
  normalizeFilters,
  salaryRange,
  seniorityOf,
  sponsorshipFromText,
  sponsorshipOf,
  type JobFilters
} from './job-filters'
import type { Job } from './jobs-types'

const NOW = new Date('2026-10-06T12:00:00Z')

const job = (over: Partial<Job> = {}): Job => ({
  id: 'indeed:1',
  source: 'indeed',
  sourceId: '1',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Portland, OR',
  remote: false,
  salary: '',
  postedAt: null,
  url: 'https://jobs.example.com/1',
  boardUrl: null,
  description: 'Build services in Go.',
  descriptionComplete: false,
  tags: [],
  fetchedAt: '2026-10-01T00:00:00Z',
  ...over
})

const only = (over: Partial<JobFilters>): JobFilters => ({ ...DEFAULT_FILTERS, ...over })

describe('sponsorshipFromText', () => {
  it.each([
    'We are unable to sponsor visas for this role.',
    'Candidates must be authorized to work in the US without sponsorship.',
    'US citizens only.',
    'Must be a U.S. citizen with an active Secret clearance.',
    'Candidates must be able to obtain a security clearance.',
    'An active TS/SCI clearance is required.',
    'This position is not eligible for visa sponsorship.',
    'No visa sponsorship is available.',
    'The company does not offer H-1B sponsorship.'
  ])('"%s" → no sponsorship', (text) => {
    expect(sponsorshipFromText(text)).toBe(false)
  })

  it.each(['H-1B sponsorship available.', 'We sponsor visas for strong candidates.', 'Visa sponsorship is offered.'])(
    '"%s" → sponsors',
    (text) => {
      expect(sponsorshipFromText(text)).toBe(true)
    }
  )

  it('is null when the posting does not say, and a refusal wins over an offer', () => {
    expect(sponsorshipFromText('Build services in Go on AWS. Great benefits.')).toBeNull()
    expect(sponsorshipFromText('')).toBeNull()
    expect(sponsorshipFromText('Visa sponsorship is available for EU roles; we cannot sponsor in the US.')).toBe(false)
  })

  it('does not read a waived or optional clearance as a refusal (review on #75)', () => {
    expect(sponsorshipFromText('No security clearance is required. Visa sponsorship is available.')).toBe(true)
    expect(sponsorshipFromText('Security clearance not required.')).toBeNull()
    expect(sponsorshipFromText('A secret clearance is a plus but not required.')).toBeNull()
    expect(sponsorshipFromText('Experience with clearance workflows in finance.')).toBeNull()
  })

  it("trusts the board's true but not its false (often just \"not mentioned\")", () => {
    expect(sponsorshipOf(job({ visaSponsorship: true }))).toBe(true)
    expect(sponsorshipOf(job({ visaSponsorship: false }))).toBeNull()
    expect(sponsorshipOf(job({ visaSponsorship: false, description: 'US citizens only.' }))).toBe(false)
  })
})

describe('job facts', () => {
  it("reads seniority from the board, else from the title", () => {
    expect(seniorityOf(job({ seniority: 'Mid Level', title: 'Senior Engineer' }))).toBe('Mid Level')
    expect(seniorityOf(job({ title: 'Sr. Backend Engineer' }))).toBe('Senior Level')
    expect(seniorityOf(job({ title: 'Staff Engineer' }))).toBe('Senior Level')
    expect(seniorityOf(job({ title: 'Junior Developer' }))).toBe('Entry Level')
    expect(seniorityOf(job({ title: 'Software Engineering Intern' }))).toBe('No Prior Experience Required')
    expect(seniorityOf(job({ title: 'Backend Engineer' }))).toBe('')
  })

  it('reads a yearly salary from the board numbers or the salary text', () => {
    expect(salaryRange(job({ salaryMin: 120000, salaryMax: null }))).toEqual({ min: 120000, max: 120000 })
    expect(salaryRange(job({ salary: '$140,000 - $165,000 a year' }))).toEqual({ min: 140000, max: 165000 })
    expect(salaryRange(job({ salary: '$120k – $150k' }))).toEqual({ min: 120000, max: 150000 })
    expect(salaryRange(job({ salary: '$60 an hour' }))).toEqual({ min: 124800, max: 124800 })
    expect(salaryRange(job({ salary: '' }))).toBeNull()
    expect(salaryRange(job({ salary: 'Competitive' }))).toBeNull()
  })
})

describe('matchesFilters', () => {
  const says = (description: string) => job({ description })
  const no = says('We are unable to sponsor visas.')
  const yes = job({ visaSponsorship: true })
  const unknown = says('Build services in Go.')

  it('passes everything with the default filters, including old jobs without the new fields', () => {
    for (const j of [no, yes, unknown, job()]) expect(matchesFilters(j, DEFAULT_FILTERS, NOW)).toBe(true)
  })

  it('sponsorship: Hide "no sponsorship" keeps unknown, Only sponsors needs a known yes', () => {
    const hide = only({ sponsorship: 'hide-no' })
    expect([no, yes, unknown].map((j) => matchesFilters(j, hide, NOW))).toEqual([false, true, true])
    const onlyYes = only({ sponsorship: 'only-yes' })
    expect([no, yes, unknown].map((j) => matchesFilters(j, onlyYes, NOW))).toEqual([false, true, false])
  })

  it('workplace: uses the board type, then the remote flag; unknown is not "remote"', () => {
    const remote = job({ remote: true })
    const hybrid = job({ workplaceType: 'Hybrid' })
    const field = job({ workplaceType: 'Field' })
    const plain = job()
    const remoteOnly = only({ workplace: ['Remote'] })
    expect([remote, hybrid, field, plain].map((j) => matchesFilters(j, remoteOnly, NOW))).toEqual([
      true,
      false,
      false,
      false
    ])
    const onsite = only({ workplace: ['Onsite'] })
    expect([remote, hybrid, field, plain].map((j) => matchesFilters(j, onsite, NOW))).toEqual([false, false, true, true])
    expect(matchesFilters(hybrid, only({ workplace: ['Remote', 'Hybrid'] }), NOW)).toBe(true)
  })

  it('seniority: by board level or title; unknown passes', () => {
    const f = only({ seniority: ['Entry Level', 'Mid Level'] })
    expect(matchesFilters(job({ seniority: 'Senior Level' }), f, NOW)).toBe(false)
    expect(matchesFilters(job({ title: 'Junior Backend Engineer' }), f, NOW)).toBe(true)
    expect(matchesFilters(job({ title: 'Principal Engineer' }), f, NOW)).toBe(false)
    expect(matchesFilters(job(), f, NOW)).toBe(true)
  })

  it('posted within N days; no date passes', () => {
    const f = only({ postedWithinDays: 7 })
    expect(matchesFilters(job({ postedAt: '2026-10-01T00:00:00Z' }), f, NOW)).toBe(true)
    expect(matchesFilters(job({ postedAt: '2026-09-20T00:00:00Z' }), f, NOW)).toBe(false)
    expect(matchesFilters(job({ postedAt: null }), f, NOW)).toBe(true)
  })

  it('minimum salary: compares the top of the range; unknown pay fails', () => {
    const f = only({ minSalary: 150000 })
    expect(matchesFilters(job({ salaryMin: 130000, salaryMax: 155000 }), f, NOW)).toBe(true)
    expect(matchesFilters(job({ salary: '$120,000 - $140,000 a year' }), f, NOW)).toBe(false)
    expect(matchesFilters(job(), f, NOW)).toBe(false)
  })
})

describe('normalizeFilters', () => {
  it('keeps valid values and drops the rest', () => {
    expect(
      normalizeFilters({
        sponsorship: 'only-yes',
        workplace: ['Remote', 'Mars', 'Remote', 'Hybrid'],
        seniority: ['Senior Level', 42],
        postedWithinDays: 7,
        minSalary: 120000.4
      })
    ).toEqual({
      sponsorship: 'only-yes',
      workplace: ['Remote', 'Hybrid'],
      seniority: ['Senior Level'],
      postedWithinDays: 7,
      minSalary: 120000
    })
    expect(
      normalizeFilters({ sponsorship: 'yes please', workplace: 'Remote', postedWithinDays: 5, minSalary: -1 })
    ).toEqual(DEFAULT_FILTERS)
    expect(normalizeFilters({ minSalary: Number.NaN }).minSalary).toBeNull()
    expect(normalizeFilters({ minSalary: 1e12 }).minSalary).toBeNull()
    expect(normalizeFilters(null)).toEqual(DEFAULT_FILTERS)
  })

  it('counts active filters', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0)
    expect(activeFilterCount(only({ sponsorship: 'hide-no', minSalary: 1 }))).toBe(2)
  })
})
