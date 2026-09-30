import { describe, expect, it } from 'vitest'
import { canFetchDetails, jobIdFor, tailorPrefillFor, type Job } from './jobs-types'

const job = (over: Partial<Job> = {}): Job => ({
  id: 'indeed:2bd2cff5c29c9fca',
  source: 'indeed',
  sourceId: '2bd2cff5c29c9fca',
  title: 'Software Engineer II',
  company: 'Ripple',
  location: 'San Francisco, CA',
  remote: false,
  salary: '',
  postedAt: null,
  url: 'https://www.indeed.com/viewjob?jk=2bd2cff5c29c9fca',
  boardUrl: null,
  description: 'Build payment rails in Go and Rust.',
  descriptionComplete: false,
  tags: [],
  fetchedAt: '2026-09-29T00:00:00Z',
  ...over
})

describe('jobIdFor', () => {
  it('uses the Indeed job key', () => {
    expect(jobIdFor(job())).toBe('2bd2cff5c29c9fca')
  })

  it('uses the employer requisition segment of a hiring.cafe id', () => {
    const hc = job({
      id: 'hiring.cafe:adp___bf746f1c-7843-49be-99d0-3cae18372ef7___594192',
      source: 'hiring.cafe',
      sourceId: 'adp___bf746f1c-7843-49be-99d0-3cae18372ef7___594192'
    })
    expect(jobIdFor(hc)).toBe('594192')
    expect(jobIdFor({ ...hc, sourceId: 'Plain_ID 42' })).toBe('plain-id-42')
  })

  it('keeps the URL / pasted hash and slugifies anything else to ≤ 40 chars', () => {
    expect(jobIdFor(job({ id: 'url:0123456789abcdef', source: 'url', sourceId: '0123456789abcdef' }))).toBe(
      '0123456789abcdef'
    )
    expect(jobIdFor(job({ source: 'pasted', sourceId: 'ABCDEF0123456789' }))).toBe('abcdef0123456789')
    const long = jobIdFor(job({ source: 'url', sourceId: `${'x'.repeat(39)}--${'y'.repeat(10)}` }))
    expect(long).toBe('x'.repeat(39))
  })

  it('never returns an empty id for a punctuation-only source id', () => {
    expect(jobIdFor(job({ id: 'url:abc', source: 'url', sourceId: '___' }))).toBe('url-abc')
    expect(jobIdFor(job({ source: 'hiring.cafe', sourceId: 'x___' }))).toBe('x')
  })
})

describe('tailorPrefillFor', () => {
  it('hands off the saved description even when it is only a summary', () => {
    const p = tailorPrefillFor(job())
    expect(p.jobDescription).toContain('# Software Engineer II')
    expect(p.jobDescription).toContain('Build payment rails in Go and Rust.')
    expect(p.jobDescription).toContain('Posting: https://www.indeed.com/viewjob?jk=2bd2cff5c29c9fca')
    expect(p).toMatchObject({
      jobUrl: 'https://www.indeed.com/viewjob?jk=2bd2cff5c29c9fca',
      company: 'Ripple',
      role: 'Software Engineer II',
      jobId: '2bd2cff5c29c9fca',
      source: 'indeed',
      descriptionComplete: false
    })
  })

  it('omits an empty company and URL', () => {
    const p = tailorPrefillFor(job({ source: 'pasted', company: '', url: '', descriptionComplete: true }))
    expect(p.company).toBeUndefined()
    expect(p.jobUrl).toBeUndefined()
    expect(p.descriptionComplete).toBe(true)
    expect(p.jobDescription).not.toContain('Posting:')
  })
})

describe('canFetchDetails', () => {
  it('offers the employer-page fetch only for summaries that are not Indeed-only', () => {
    expect(canFetchDetails(job())).toBe(false)
    expect(canFetchDetails(job({ aliases: ['hiring.cafe:x'] }))).toBe(true)
    expect(canFetchDetails(job({ source: 'hiring.cafe' }))).toBe(true)
    expect(canFetchDetails(job({ source: 'hiring.cafe', descriptionComplete: true }))).toBe(false)
  })
})
