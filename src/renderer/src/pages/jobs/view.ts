import { matchesFilters, type JobFilters } from '@shared/job-filters'
import type { ScoredJob } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'

/** Segments of the saved-job list. */
export type Show = 'relevant' | 'search' | 'all' | 'new' | 'tailored' | 'dismissed'

/** Relevant when the profile has a headline or a role to match on, else every saved job. */
export function defaultShow(hasProfileSignals: boolean): Show {
  return hasProfileSignals ? 'relevant' : 'all'
}

/**
 * The jobs a segment lists, after the filters and the text box. Relevant is
 * ordered by score (and never has dismissed jobs); the others keep the saved
 * order (newest posting first).
 */
export function visibleJobs(input: {
  jobs: readonly Job[]
  show: Show
  relevant: readonly ScoredJob[]
  lastIds: ReadonlySet<string> | null
  filters: JobFilters
  text: string
  now?: Date
}): Job[] {
  const { jobs, show, relevant, lastIds, filters, now = new Date() } = input
  const q = input.text.trim().toLowerCase()
  const base = show === 'relevant' ? relevant.map((r) => r.job) : jobs
  return base.filter((j) => {
    if (show === 'search' && !lastIds?.has(j.id)) return false
    if (show === 'dismissed' ? !j.dismissed : j.dismissed) return false
    if (show === 'new' && j.tailoredAt) return false
    if (show === 'tailored' && !j.tailoredAt) return false
    if (!matchesFilters(j, filters, now)) return false
    return !q || [j.title, j.company, j.location, j.tags.join(' ')].some((s) => s.toLowerCase().includes(q))
  })
}
