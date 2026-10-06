import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS } from './job-filters'
import { autoRefreshDue, DEFAULT_JOBS_PREFS, normalizePrefs, normalizePrefsPatch } from './jobs-prefs'

const NOW = new Date('2026-10-06T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

describe('autoRefreshDue', () => {
  it('is due when on and the last refresh is 12 h old or never ran', () => {
    expect(autoRefreshDue({ autoRefresh: true, lastRefreshAt: null }, NOW)).toBe(true)
    expect(autoRefreshDue({ autoRefresh: true, lastRefreshAt: hoursAgo(13) }, NOW)).toBe(true)
    expect(autoRefreshDue({ autoRefresh: true, lastRefreshAt: hoursAgo(12) }, NOW)).toBe(true)
    expect(autoRefreshDue({ autoRefresh: true, lastRefreshAt: hoursAgo(11) }, NOW)).toBe(false)
    expect(autoRefreshDue({ autoRefresh: true, lastRefreshAt: hoursAgo(0.1) }, NOW)).toBe(false)
  })

  it('is never due when off', () => {
    expect(autoRefreshDue({ autoRefresh: false, lastRefreshAt: null }, NOW)).toBe(false)
    expect(autoRefreshDue({ autoRefresh: false, lastRefreshAt: hoursAgo(100) }, NOW)).toBe(false)
  })

  it('treats a refresh time in the future (clock moved back) as stale', () => {
    expect(autoRefreshDue({ autoRefresh: true, lastRefreshAt: hoursAgo(-5) }, NOW)).toBe(true)
  })

  it('is on by default', () => {
    expect(DEFAULT_JOBS_PREFS.autoRefresh).toBe(true)
    expect(autoRefreshDue(DEFAULT_JOBS_PREFS, NOW)).toBe(true)
  })
})

describe('normalizePrefs', () => {
  it('fills defaults and drops bad fields from the file', () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_JOBS_PREFS)
    expect(
      normalizePrefs({
        autoRefresh: 'yes',
        lastRefreshAt: 'yesterday',
        filters: { sponsorship: 'hide-no' },
        lastSearch: {
          query: { keywords: 'go', location: 'Austin', remoteOnly: true, sources: ['indeed', 'monster'] },
          at: '2026-10-06T00:00:00.000Z',
          ids: ['indeed:1', '../../etc', 7],
          relevant: true
        }
      })
    ).toEqual({
      autoRefresh: true,
      lastRefreshAt: null,
      filters: { ...DEFAULT_FILTERS, sponsorship: 'hide-no' },
      lastSearch: {
        query: { keywords: 'go', location: 'Austin', remoteOnly: true, sources: ['indeed'] },
        at: '2026-10-06T00:00:00.000Z',
        ids: ['indeed:1'],
        relevant: true
      }
    })
    expect(normalizePrefs({ lastSearch: { query: {}, at: 'nope', ids: [] } }).lastSearch).toBeNull()
  })
})

describe('normalizePrefsPatch (renderer input)', () => {
  it('accepts filters and the auto-refresh toggle, normalizing filter values', () => {
    expect(normalizePrefsPatch({ autoRefresh: false })).toEqual({ autoRefresh: false })
    expect(normalizePrefsPatch({ filters: { sponsorship: 'only-yes', workplace: ['Moon'] } })).toEqual({
      filters: { ...DEFAULT_FILTERS, sponsorship: 'only-yes' }
    })
  })

  it('refuses anything else', () => {
    expect(() => normalizePrefsPatch(null)).toThrow(/Invalid/)
    expect(() => normalizePrefsPatch([])).toThrow(/Invalid/)
    expect(() => normalizePrefsPatch({ lastRefreshAt: '2030-01-01' })).toThrow(/Unknown Jobs preference: lastRefreshAt/)
    expect(() => normalizePrefsPatch({ autoRefresh: 'on' })).toThrow(/true or false/)
  })
})
