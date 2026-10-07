import { describe, expect, it } from 'vitest'
import { tailorPrefillFor, type Job } from '@shared/jobs-types'
import { DEFAULT_LOCATION, FULL_BLEED, locationOf, PAGES, paramsFor } from './navigation'

describe('navigation', () => {
  it('starts on the dashboard and lists every page once', () => {
    expect(DEFAULT_LOCATION.page).toBe('dashboard')
    expect(new Set(PAGES).size).toBe(PAGES.length)
    expect(PAGES).toContain('profile')
  })

  it('carries typed params to the target page', () => {
    const loc = locationOf('tailor', { jobUrl: 'https://example.com/job/1', company: 'Acme' })
    expect(paramsFor(loc, 'tailor')?.company).toBe('Acme')
    expect(paramsFor(loc, 'jobs')).toBeUndefined()
  })

  it('carries a job sent from the Jobs page, including its id and summary flag', () => {
    const job = {
      id: 'indeed:2bd2cff5c29c9fca',
      source: 'indeed',
      sourceId: '2bd2cff5c29c9fca',
      title: 'Software Engineer II',
      company: 'Ripple',
      location: '',
      remote: true,
      salary: '',
      postedAt: null,
      url: 'https://www.indeed.com/viewjob?jk=2bd2cff5c29c9fca',
      boardUrl: null,
      description: 'Snippet.',
      descriptionComplete: false,
      tags: [],
      fetchedAt: '2026-09-29T00:00:00Z'
    } satisfies Job
    const params = paramsFor(locationOf('tailor', tailorPrefillFor(job)), 'tailor')
    expect(params).toMatchObject({ jobId: '2bd2cff5c29c9fca', descriptionComplete: false, source: 'indeed' })
    expect(params?.jobDescription).toContain('Snippet.')
  })

  it('lists the Board right after the Dashboard (#85)', () => {
    expect(PAGES.indexOf('board')).toBe(PAGES.indexOf('dashboard') + 1)
    expect(FULL_BLEED.has('board')).toBe(false)
  })

  it('allows omitting params where they are optional', () => {
    expect(locationOf('settings')).toEqual({ page: 'settings', params: undefined })
    expect(paramsFor(locationOf('profile', { section: 'experience' }), 'profile')?.section).toBe('experience')
  })

  it('has a full-bleed Browser page between Jobs and Tailor that takes a URL', () => {
    expect(PAGES.indexOf('browser')).toBe(PAGES.indexOf('jobs') + 1)
    expect(PAGES.indexOf('tailor')).toBe(PAGES.indexOf('browser') + 1)
    expect(FULL_BLEED.has('browser')).toBe(true)
    expect(FULL_BLEED.has('dashboard')).toBe(false)
    const loc = locationOf('browser', { url: 'https://jobs.example.com/1' })
    expect(paramsFor(loc, 'browser')?.url).toBe('https://jobs.example.com/1')
    expect(locationOf('browser')).toEqual({ page: 'browser', params: undefined })
  })
})
