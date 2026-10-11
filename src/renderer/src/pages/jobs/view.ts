import { matchesFilters, type JobFilters } from '@shared/job-filters'
import { hasRelevanceSignals, scoreJob, type JobScore, type ProfileSignals, type ScoredJob } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'

/**
 * The Scent score of every saved job (the relevance score of #73, shown on each row and in the drawer),
 * by job id. Relevant jobs keep the score they were ranked by; the others are scored the same way.
 * Empty when the profile has nothing to match on.
 */
export function scentScores(
  jobs: readonly Job[],
  signals: ProfileSignals | null,
  relevant: readonly ScoredJob[] = [],
  now = new Date()
): Map<string, JobScore> {
  if (!signals || !hasRelevanceSignals(signals)) return new Map()
  const ranked = new Map(relevant.map((r) => [r.job.id, r.score]))
  return new Map(jobs.map((j) => [j.id, ranked.get(j.id) ?? scoreJob(j, signals, now)]))
}

/** Segments of the saved-job list. */
export type Show = 'relevant' | 'all' | 'new' | 'tailored' | 'dismissed'

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
  filters: JobFilters
  text: string
  now?: Date
}): Job[] {
  const { jobs, show, relevant, filters, now = new Date() } = input
  const q = input.text.trim().toLowerCase()
  const base = show === 'relevant' ? relevant.map((r) => r.job) : jobs
  return base.filter((j) => {
    if (show === 'dismissed' ? !j.dismissed : j.dismissed) return false
    if (show === 'new' && j.tailoredAt) return false
    if (show === 'tailored' && !j.tailoredAt) return false
    if (!matchesFilters(j, filters, now)) return false
    return !q || [j.title, j.company, j.location, j.tags.join(' ')].some((s) => s.toLowerCase().includes(q))
  })
}
