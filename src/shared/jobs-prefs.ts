import { DEFAULT_FILTERS, normalizeFilters, type JobFilters } from './job-filters'

/**
 * Jobs page preferences of a workspace (`.huntgry/jobs-prefs.json`, #73): the
 * saved-list filters, so they survive leaving the page. Files written before
 * board search was removed (#78) also hold auto-refresh and last-search
 * fields; they are ignored.
 */

export interface JobsPrefs {
  filters: JobFilters
}

/** What the renderer may change. */
export interface JobsPrefsPatch {
  filters?: JobFilters
}

export const DEFAULT_JOBS_PREFS: JobsPrefs = {
  filters: DEFAULT_FILTERS
}

/** Preferences read from disk (or anything else): every field checked, a missing or bad one gets its default. */
export function normalizePrefs(input: unknown): JobsPrefs {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  return { filters: normalizeFilters(p.filters) }
}

/** A patch from the renderer: only `filters`, validated; anything else is refused. */
export function normalizePrefsPatch(input: unknown): JobsPrefsPatch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid Jobs preferences.')
  const p = input as Record<string, unknown>
  const unknown = Object.keys(p).filter((k) => k !== 'filters')
  if (unknown.length > 0) throw new Error(`Unknown Jobs preference: ${unknown.join(', ')}.`)
  const out: JobsPrefsPatch = {}
  if ('filters' in p) out.filters = normalizeFilters(p.filters)
  return out
}
