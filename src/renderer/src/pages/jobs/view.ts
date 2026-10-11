import { matchesFilters, type JobFilters } from '@shared/job-filters'
import {
  hasRelevanceSignals,
  rankRelevant,
  scoreJob,
  type JobScore,
  type ProfileSignals,
  type ScoredJob
} from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'

/**
 * One scoring pass over the saved jobs: the Scent score of every job by id (the relevance score of #73,
 * shown on each row and in the drawer), and the Relevant list ranked from those same scores (what
 * `relevantJobs` gives). Both empty when the profile has nothing to match on.
 */
export function scentView(
  jobs: readonly Job[],
  signals: ProfileSignals | null,
  now = new Date()
): { scores: Map<string, JobScore>; relevant: ScoredJob[] } {
  if (!signals || !hasRelevanceSignals(signals)) return { scores: new Map(), relevant: [] }
  const scored = jobs.map((job) => ({ job, score: scoreJob(job, signals, now) }))
  return { scores: new Map(scored.map((s) => [s.job.id, s.score])), relevant: rankRelevant(scored) }
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
