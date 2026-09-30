import { describe, expect, it } from 'vitest'
import { applyUrlFor, atsForHost, isGreenhouseEmbedUrl } from './apply-url'
import { asUrl, currentCompany, fillValuesFrom, splitName } from './apply-values'
import { emptyContact, type ExperienceEntry, type MasterProfile } from './master-profile'

describe('applyUrlFor', () => {
  it('adds /apply to a Lever posting, once', () => {
    const posting = 'https://jobs.lever.co/acme/0f3c1f5a-1111-4222-8333-944445555666'
    expect(applyUrlFor(posting)).toBe(`${posting}/apply`)
    expect(applyUrlFor(`${posting}/apply`)).toBe(`${posting}/apply`)
    expect(applyUrlFor(`${posting}/`)).toBe(`${posting}/apply`)
    expect(applyUrlFor(`${posting}?lever-source=LinkedIn`)).toBe(`${posting}/apply?lever-source=LinkedIn`)
    expect(applyUrlFor('https://jobs.eu.lever.co/acme/abc')).toBe('https://jobs.eu.lever.co/acme/abc/apply')
  })

  it('adds /application to an Ashby posting', () => {
    expect(applyUrlFor('https://jobs.ashbyhq.com/acme/1234')).toBe('https://jobs.ashbyhq.com/acme/1234/application')
    expect(applyUrlFor('https://jobs.ashbyhq.com/acme/1234/application')).toBe(
      'https://jobs.ashbyhq.com/acme/1234/application'
    )
  })

  it('keeps Greenhouse and other postings as they are (minus the fragment)', () => {
    expect(applyUrlFor('https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x')).toBe(
      'https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x'
    )
    expect(applyUrlFor('https://careers.example.com/jobs/42#apply')).toBe('https://careers.example.com/jobs/42')
    expect(applyUrlFor('https://jobs.lever.co/acme')).toBe('https://jobs.lever.co/acme')
  })

  it('refuses anything but http(s)', () => {
    expect(() => applyUrlFor('javascript:alert(1)')).toThrow(/http/)
    expect(() => applyUrlFor('file:///etc/passwd')).toThrow(/http/)
    expect(() => applyUrlFor('not a url')).toThrow(/not valid/)
  })

  it('knows the ATS by host', () => {
    expect(atsForHost('job-boards.greenhouse.io')).toBe('greenhouse')
    expect(atsForHost('boards.greenhouse.io')).toBe('greenhouse')
    expect(atsForHost('job-boards.eu.greenhouse.io')).toBe('greenhouse')
    expect(atsForHost('jobs.lever.co')).toBe('lever')
    expect(atsForHost('greenhouse.io.evil.example')).toBe('generic')
  })

  it('accepts only https Greenhouse embed URLs', () => {
    expect(isGreenhouseEmbedUrl('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1')).toBe(true)
    expect(isGreenhouseEmbedUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=1')).toBe(true)
    expect(isGreenhouseEmbedUrl('http://boards.greenhouse.io/embed/job_app?for=acme')).toBe(false)
    expect(isGreenhouseEmbedUrl('https://evil.example/embed/job_app')).toBe(false)
  })
})

describe('fill values', () => {
  it('splits names', () => {
    expect(splitName('Ada Lovelace')).toEqual({ first: 'Ada', last: 'Lovelace' })
    expect(splitName('  Mary   Jane  Watson ')).toEqual({ first: 'Mary Jane', last: 'Watson' })
    expect(splitName('Ludwig van Beethoven')).toEqual({ first: 'Ludwig', last: 'van Beethoven' })
    expect(splitName('Maria de la Cruz')).toEqual({ first: 'Maria', last: 'de la Cruz' })
    expect(splitName('Prince')).toEqual({ first: 'Prince', last: '' })
    expect(splitName('')).toEqual({ first: '', last: '' })
  })

  it('turns profile links into URLs', () => {
    expect(asUrl('linkedin.com/in/ada')).toBe('https://linkedin.com/in/ada')
    expect(asUrl('https://github.com/ada')).toBe('https://github.com/ada')
    expect(asUrl('ada', 'https://github.com/')).toBe('https://github.com/ada')
    expect(asUrl('@ada', 'https://github.com/')).toBe('https://github.com/ada')
    expect(asUrl('')).toBe('')
  })

  const job = (company: string, end: string): ExperienceEntry => ({
    company,
    role: 'Engineer',
    start: '2020',
    end,
    location: '',
    employmentType: '',
    project: '',
    projectLink: '',
    technologies: '',
    highlights: []
  })

  const profile = (patch: Partial<MasterProfile> = {}): MasterProfile => ({
    contact: emptyContact(),
    summary: '',
    skills: [],
    experience: [],
    projects: [],
    education: [],
    certifications: [],
    publications: [],
    gaps: [],
    extraSections: [],
    ...patch
  })

  it('gives empty strings for an empty profile', () => {
    expect(Object.values(fillValuesFrom(profile())).every((v) => v === '')).toBe(true)
  })

  it('takes the current employer from an entry that has not ended', () => {
    expect(currentCompany(profile({ experience: [job('Old Co', '2021'), job('Now Co', 'Present')] }))).toBe('Now Co')
    expect(currentCompany(profile({ experience: [job('Old Co', '2021')] }))).toBe('')
  })

  it('maps the contact block', () => {
    const p = profile({
      contact: {
        ...emptyContact(),
        name: 'Ada  Lovelace',
        email: ' ada@example.com ',
        phone: '+44 20 7946 0000',
        location: 'London',
        linkedin: 'linkedin.com/in/ada',
        github: 'ada',
        website: 'https://ada.example'
      }
    })
    expect(fillValuesFrom(p)).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+44 20 7946 0000',
      location: 'London',
      linkedin: 'https://linkedin.com/in/ada',
      github: 'https://github.com/ada',
      website: 'https://ada.example',
      currentCompany: ''
    })
  })
})
