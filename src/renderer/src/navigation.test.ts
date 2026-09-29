import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCATION, locationOf, PAGES, paramsFor } from './navigation'

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

  it('allows omitting params where they are optional', () => {
    expect(locationOf('settings')).toEqual({ page: 'settings', params: undefined })
    expect(paramsFor(locationOf('profile', { section: 'experience' }), 'profile')?.section).toBe('experience')
  })
})
