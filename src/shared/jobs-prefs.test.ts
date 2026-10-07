import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS } from './job-filters'
import { DEFAULT_JOBS_PREFS, normalizePrefs, normalizePrefsPatch } from './jobs-prefs'

describe('normalizePrefs', () => {
  it('fills defaults and drops bad or retired fields from the file', () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_JOBS_PREFS)
    expect(
      normalizePrefs({
        autoRefresh: false,
        lastRefreshAt: '2026-10-06T00:00:00.000Z',
        filters: { sponsorship: 'hide-no' },
        lastSearch: { query: { keywords: 'go' }, at: '2026-10-06T00:00:00.000Z', ids: [], relevant: true }
      })
    ).toEqual({ filters: { ...DEFAULT_FILTERS, sponsorship: 'hide-no' } })
  })
})

describe('normalizePrefsPatch (renderer input)', () => {
  it('accepts filters, normalizing their values', () => {
    expect(normalizePrefsPatch({ filters: { sponsorship: 'only-yes', workplace: ['Moon'] } })).toEqual({
      filters: { ...DEFAULT_FILTERS, sponsorship: 'only-yes' }
    })
  })

  it('refuses anything else', () => {
    expect(() => normalizePrefsPatch(null)).toThrow(/Invalid/)
    expect(() => normalizePrefsPatch([])).toThrow(/Invalid/)
    expect(() => normalizePrefsPatch({ autoRefresh: false })).toThrow(/Unknown Jobs preference: autoRefresh/)
  })
})
