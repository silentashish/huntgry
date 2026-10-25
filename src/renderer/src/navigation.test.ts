import { describe, expect, it } from 'vitest'
import { tailorPrefillFor, type Job } from '@shared/jobs-types'
import { DEFAULT_LOCATION, FULL_BLEED, locationOf, PAGES, paramsFor, redirect, WIDE, type Location } from './navigation'

describe('navigation', () => {
  it('starts on the dashboard and lists every page once', () => {
    expect(DEFAULT_LOCATION.page).toBe('dashboard')
    expect(new Set(PAGES).size).toBe(PAGES.length)
    expect(PAGES).toContain('profile')
  })

  it('has 10 sidebar entries: the Knowledge graph is a view of Profile (#108), Automation follows Review (#154)', () => {
    expect(PAGES).toEqual(['dashboard', 'board', 'jobs', 'explore', 'browser', 'tailor', 'review', 'automation', 'profile', 'settings'])
    expect(PAGES as readonly string[]).not.toContain('graph')
  })

  it('opens the graph page as the Profile graph view, keeping the node (#108)', () => {
    expect(locationOf('graph')).toEqual({ page: 'profile', params: { view: 'graph' } })
    expect(locationOf('graph', { nodeId: 'skill:postgres' })).toEqual({ page: 'profile', params: { view: 'graph', nodeId: 'skill:postgres' } })
    const raw = { page: 'graph', params: { nodeId: 'role:0' } } as Location
    expect(redirect(raw)).toEqual({ page: 'profile', params: { view: 'graph', nodeId: 'role:0' } })
    expect(paramsFor(redirect(raw), 'graph')).toBeUndefined()
  })

  it('leaves every other location as it is', () => {
    const tailor = locationOf('tailor', { runId: 'r-1' })
    expect(redirect(tailor)).toBe(tailor)
    expect(locationOf('profile', { view: 'skills' })).toEqual({ page: 'profile', params: { view: 'skills' } })
    expect(paramsFor(locationOf('settings', { section: 'pricing' }), 'settings')?.section).toBe('pricing')
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

  it('draws only the Board wide, without the max width but with padding (#90)', () => {
    expect([...WIDE]).toEqual(['board'])
    for (const page of WIDE) expect(FULL_BLEED.has(page)).toBe(false)
  })

  it('lists Automation right after Review and opens it on a candidate (#154)', () => {
    expect(PAGES.indexOf('automation')).toBe(PAGES.indexOf('review') + 1)
    expect(paramsFor(locationOf('automation', { key: 'jobright:a3' }), 'automation')?.key).toBe('jobright:a3')
    expect(locationOf('automation')).toEqual({ page: 'automation', params: undefined })
  })

  it('allows omitting params where they are optional', () => {
    expect(locationOf('settings')).toEqual({ page: 'settings', params: undefined })
    expect(paramsFor(locationOf('profile', { section: 'experience' }), 'profile')?.section).toBe('experience')
  })

  it('opens a Profile view and a graph node (#107: Profile + Knowledge graph)', () => {
    expect(paramsFor(locationOf('profile', { view: 'graph', nodeId: 'skill:postgres' }), 'profile')).toEqual({
      view: 'graph',
      nodeId: 'skill:postgres'
    })
    expect(paramsFor(locationOf('profile', { view: 'skills' }), 'profile')?.view).toBe('skills')
  })

  it('has Explore between Jobs and Browser, and Jobs opens a saved job (#142)', () => {
    expect(PAGES.indexOf('explore')).toBe(PAGES.indexOf('jobs') + 1)
    expect(PAGES.indexOf('browser')).toBe(PAGES.indexOf('explore') + 1)
    expect(paramsFor(locationOf('jobs', { reload: 1, openId: 'jobright:abc123' }), 'jobs')?.openId).toBe('jobright:abc123')
  })

  it('has a full-bleed Browser page between Explore and Tailor that takes a URL', () => {
    expect(PAGES.indexOf('browser')).toBe(PAGES.indexOf('explore') + 1)
    expect(PAGES.indexOf('tailor')).toBe(PAGES.indexOf('browser') + 1)
    expect(FULL_BLEED.has('browser')).toBe(true)
    expect(FULL_BLEED.has('dashboard')).toBe(false)
    const loc = locationOf('browser', { url: 'https://jobs.example.com/1' })
    expect(paramsFor(loc, 'browser')?.url).toBe('https://jobs.example.com/1')
    expect(locationOf('browser')).toEqual({ page: 'browser', params: undefined })
  })
})
