import { DEFAULT_FILTERS, normalizeFilters, type JobFilters } from './job-filters'
import { JOB_ID_PATTERN, type JobQuery } from './jobs-types'

/**
 * Jobs page preferences of a workspace (`.huntgry/jobs-prefs.json`, #73): the
 * saved-list filters, the auto-refresh toggle, and what the last search and
 * the last profile refresh found, so they survive leaving the page.
 */

export interface LastSearch {
  query: JobQuery
  at: string
  /** Canonical ids of the jobs it returned. */
  ids: string[]
  /** `true` for a profile-derived refresh, `false` for a search typed on the page. */
  relevant: boolean
}

export interface JobsPrefs {
  filters: JobFilters
  /** Refresh the relevant jobs when the Jobs page opens and the last refresh is older than `AUTO_REFRESH_AFTER_MS`. */
  autoRefresh: boolean
  /** When the last profile-derived refresh finished (any result), or `null`. */
  lastRefreshAt: string | null
  lastSearch: LastSearch | null
}

/** What the renderer may change; the rest is written by main as searches run. */
export interface JobsPrefsPatch {
  filters?: JobFilters
  autoRefresh?: boolean
}

export const DEFAULT_JOBS_PREFS: JobsPrefs = {
  filters: DEFAULT_FILTERS,
  autoRefresh: true,
  lastRefreshAt: null,
  lastSearch: null
}

export const AUTO_REFRESH_AFTER_MS = 12 * 60 * 60 * 1000

const MAX_LAST_IDS = 500

const isDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))

function normalizeLastSearch(input: unknown): LastSearch | null {
  if (typeof input !== 'object' || input === null) return null
  const s = input as Record<string, unknown>
  const q = (typeof s.query === 'object' && s.query !== null ? s.query : null) as Record<string, unknown> | null
  if (!q || !isDate(s.at) || !Array.isArray(s.ids)) return null
  return {
    query: {
      keywords: typeof q.keywords === 'string' ? q.keywords : '',
      location: typeof q.location === 'string' ? q.location : '',
      remoteOnly: q.remoteOnly === true,
      sources: Array.isArray(q.sources) ? q.sources.filter((x) => x === 'hiring.cafe' || x === 'indeed') : []
    },
    at: s.at,
    ids: s.ids.filter((id): id is string => typeof id === 'string' && JOB_ID_PATTERN.test(id)).slice(0, MAX_LAST_IDS),
    relevant: s.relevant === true
  }
}

/** Preferences read from disk (or anything else): every field checked, a missing or bad one gets its default. */
export function normalizePrefs(input: unknown): JobsPrefs {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  return {
    filters: normalizeFilters(p.filters),
    autoRefresh: typeof p.autoRefresh === 'boolean' ? p.autoRefresh : DEFAULT_JOBS_PREFS.autoRefresh,
    lastRefreshAt: isDate(p.lastRefreshAt) ? p.lastRefreshAt : null,
    lastSearch: normalizeLastSearch(p.lastSearch)
  }
}

/** A patch from the renderer: only `filters` and `autoRefresh`, validated; anything else is refused. */
export function normalizePrefsPatch(input: unknown): JobsPrefsPatch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid Jobs preferences.')
  const p = input as Record<string, unknown>
  const unknown = Object.keys(p).filter((k) => k !== 'filters' && k !== 'autoRefresh')
  if (unknown.length > 0) throw new Error(`Unknown Jobs preference: ${unknown.join(', ')}.`)
  const out: JobsPrefsPatch = {}
  if ('filters' in p) out.filters = normalizeFilters(p.filters)
  if ('autoRefresh' in p) {
    if (typeof p.autoRefresh !== 'boolean') throw new Error('autoRefresh must be true or false.')
    out.autoRefresh = p.autoRefresh
  }
  return out
}

/** Whether opening the Jobs page should refresh the relevant jobs now: on, and the last refresh is old or never ran. */
export function autoRefreshDue(prefs: Pick<JobsPrefs, 'autoRefresh' | 'lastRefreshAt'>, now = new Date()): boolean {
  if (!prefs.autoRefresh) return false
  if (!prefs.lastRefreshAt) return true
  const last = Date.parse(prefs.lastRefreshAt)
  // A time in the future (clock changed) counts as stale rather than blocking refreshes forever.
  return !Number.isFinite(last) || last > now.getTime() || now.getTime() - last >= AUTO_REFRESH_AFTER_MS
}
