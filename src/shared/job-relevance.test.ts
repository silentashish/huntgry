import { describe, expect, it } from 'vitest'
import {
  hasRelevanceSignals,
  needsSponsorshipFrom,
  profileSignals,
  relevantJobs,
  relevantQuery,
  scoreJob,
  shortTitle,
  type ProfileSignals
} from './job-relevance'
import type { Job } from './jobs-types'
import { emptyExperience, emptyProfile, type MasterProfile } from './master-profile'

const NOW = new Date('2026-10-06T12:00:00Z')

function backend(): MasterProfile {
  const p = emptyProfile()
  p.contact.headline = 'Backend Engineer | Payments'
  p.contact.location = 'Portland, OR'
  p.skills = [{ category: 'Languages', items: ['Go', 'Python', 'TypeScript', 'PostgreSQL', 'AWS'] }]
  p.experience = [
    { ...emptyExperience(), role: 'Software Engineer', start: 'Jun 2018', end: 'Dec 2021', technologies: 'Python, Django' },
    { ...emptyExperience(), role: 'Senior Backend Engineer', start: 'Jan 2022', end: 'Present', technologies: 'Go, AWS' }
  ]
  return p
}

const job = (over: Partial<Job>): Job => ({
  id: `pasted:${over.title?.replace(/\W+/g, '') ?? 'x'}`,
  source: 'pasted',
  sourceId: 'x',
  title: 'Engineer',
  company: 'Acme',
  location: '',
  remote: false,
  salary: '',
  postedAt: '2026-10-03T00:00:00Z',
  url: '',
  boardUrl: null,
  description: '',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-03T00:00:00Z',
  ...over
})

const backendTs = job({
  title: 'Senior Backend Engineer',
  location: 'Remote',
  remote: true,
  description: 'Build payment services in Go and TypeScript on AWS with PostgreSQL.'
})
const nurse = job({
  title: 'Registered Nurse',
  location: 'Portland, OR',
  description: 'Provide patient care on the night shift. BLS certification required.'
})
const mechanical = job({
  title: 'Mechanical Engineer',
  location: 'Portland, OR',
  description: 'Design brackets in SolidWorks.'
})

describe('needsSponsorshipFrom', () => {
  it.each([
    'Needs H-1B sponsorship',
    'F-1 OPT, will need sponsorship',
    'Not a US citizen, needs sponsorship',
    'STEM OPT until 2027',
    'On H-1B today; will require sponsorship for a transfer'
  ])(
    '"%s" → needs a sponsor',
    (text) => expect(needsSponsorshipFrom(text)).toBe(true)
  )
  it.each([
    'US citizen',
    'Green card holder, no sponsorship needed',
    'Authorized to work in the US without sponsorship',
    // A visa status next to an explicit "no sponsorship needed" is not a need (review on #75).
    'Authorized to work on H-4 EAD, no sponsorship needed',
    'TN visa holder. Sponsorship is not required.',
    ''
  ])(
    '"%s" → does not',
    (text) => expect(needsSponsorshipFrom(text)).toBe(false)
  )
})

describe('profileSignals', () => {
  it('takes titles from the headline and the two most recent roles, skills from the graph, and the years', () => {
    const s = profileSignals(backend(), NOW)
    expect(s.titles).toEqual(['Backend Engineer', 'Senior Backend Engineer', 'Software Engineer'])
    expect(s.skills).toEqual(expect.arrayContaining(['Go', 'Python', 'PostgreSQL', 'AWS', 'Django']))
    expect(s.location).toBe('Portland, OR')
    expect(s.remote).toBe(false)
    expect(s.needsSponsorship).toBe(false)
    expect(s.years).toBeGreaterThan(8)
    expect(s.years).toBeLessThan(9)
  })

  it('reads work authorization and gaps for sponsorship, and a "Remote" location', () => {
    const p = backend()
    p.contact.workAuthorization = 'F-1 OPT, will need sponsorship'
    p.contact.location = 'Remote (US)'
    const s = profileSignals(p, NOW)
    expect(s.needsSponsorship).toBe(true)
    expect(s.remote).toBe(true)
    expect(s.location).toBe('')
    const g = backend()
    g.gaps = ['Requires H-1B sponsorship for any US role']
    expect(profileSignals(g, NOW).needsSponsorship).toBe(true)
  })

  it('has no titles for an empty profile', () => {
    const s = profileSignals(emptyProfile(), NOW)
    expect(s).toMatchObject({ titles: [], skills: [], location: '', needsSponsorship: false, years: 0 })
    expect(hasRelevanceSignals(s)).toBe(false)
    expect(relevantQuery(s, ['indeed'])).toBeNull()
    expect(relevantJobs([backendTs], s, NOW)).toEqual([])
  })

  it('falls back to the latest role without a headline', () => {
    const p = backend()
    p.contact.headline = ''
    expect(profileSignals(p, NOW).titles[0]).toBe('Senior Backend Engineer')
  })
})

describe('shortTitle and relevantQuery', () => {
  it('shortens a headline to a search title', () => {
    expect(shortTitle('Full-Stack Software Engineer | AI')).toBe('Full-Stack Software Engineer')
    expect(shortTitle('Data Scientist · ML')).toBe('Data Scientist')
    expect(shortTitle('Software Engineer, Payments')).toBe('Software Engineer')
    expect(shortTitle('  Platform   Engineer (Kubernetes) ')).toBe('Platform Engineer')
  })

  it('searches the first title near the profile location, or remote only', () => {
    const s = profileSignals(backend(), NOW)
    expect(relevantQuery(s, ['hiring.cafe'])).toEqual({
      keywords: 'Backend Engineer',
      location: 'Portland, OR',
      remoteOnly: false,
      sources: ['hiring.cafe']
    })
    expect(relevantQuery({ ...s, remote: true, location: '' }, ['indeed'])).toMatchObject({ location: '', remoteOnly: true })
  })
})

describe('scoreJob and relevantJobs', () => {
  const s: ProfileSignals = profileSignals(backend(), NOW)

  it('ranks a job matching the title and skills above unrelated ones, with readable reasons', () => {
    const good = scoreJob(backendTs, s, NOW)
    const bad = scoreJob(nurse, s, NOW)
    expect(good.score).toBeGreaterThan(bad.score)
    expect(good.reasons).toEqual(
      expect.arrayContaining(['Title: Backend Engineer', 'Remote', 'Posted this week'])
    )
    expect(good.reasons.find((r) => r.startsWith('Skills: '))).toMatch(/Go/)
    expect(good.matched).toBe(true)
    expect(bad.matched).toBe(false)

    const list = relevantJobs([nurse, mechanical, backendTs], s, NOW)
    expect(list.map((r) => r.job.title)).toEqual(['Senior Backend Engineer'])
  })

  it('orders by score', () => {
    const python = job({
      title: 'Python Developer',
      location: 'Austin, TX',
      postedAt: '2026-08-01T00:00:00Z',
      description: 'Python and Django services.'
    })
    const list = relevantJobs([python, backendTs], s, NOW, 0)
    expect(list.map((r) => r.job.title)).toEqual(['Senior Backend Engineer', 'Python Developer'])
    expect(list[0].score.score).toBeGreaterThan(list[1].score.score)
  })

  it('a job that shares only "Engineer" with the profile is not relevant', () => {
    expect(scoreJob(mechanical, s, NOW).matched).toBe(false)
  })

  it('excludes dismissed jobs, and "no sponsorship" jobs when the profile needs a sponsor', () => {
    expect(scoreJob({ ...backendTs, dismissed: true }, s, NOW).excluded).toBe('Dismissed')
    const noVisa = { ...backendTs, description: `${backendTs.description} We are unable to sponsor visas.` }
    expect(scoreJob(noVisa, s, NOW).excluded).toBeUndefined()
    const needs = { ...s, needsSponsorship: true }
    expect(scoreJob(noVisa, needs, NOW).excluded).toBe('Says it does not sponsor visas')
    expect(relevantJobs([noVisa], needs, NOW, 0)).toEqual([])
    // hiring.cafe's `false` alone is "not mentioned", so the job stays.
    expect(scoreJob({ ...backendTs, visaSponsorship: false }, needs, NOW).excluded).toBeUndefined()
    expect(scoreJob({ ...backendTs, visaSponsorship: true }, needs, NOW).reasons).toContain('Sponsors visas')
  })

  it('scores seniority against the years of experience', () => {
    const junior = { ...s, years: 1 }
    const staff = job({ ...backendTs, title: 'Staff Backend Engineer' })
    expect(scoreJob(staff, s, NOW).score).toBeGreaterThan(scoreJob(staff, junior, NOW).score)
  })

  it('works on old saved jobs without the structured fields', () => {
    const old = job({ title: 'Backend Engineer', description: 'Go', tags: ['Go'] })
    expect(() => relevantJobs([old], s, NOW)).not.toThrow()
  })
})
