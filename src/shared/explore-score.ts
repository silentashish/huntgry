import { savedJobId, type ExploreJob } from './explore-types'
import { scoreJob, titleEstimate, type ProfileSignals } from './job-relevance'
import type { Job, WorkplaceType } from './jobs-types'
import type { MatchGate, MatchSkill } from './match-score'

/**
 * Explore's match scores (#150). A row from the newgrad-jobs API carries Jobright's `qualifications` (#169):
 * it is scored from them with the match score (#149), exactly as the job it is saved as, since that job's
 * description is those qualifications. A row from the GitHub README has none: it gets a title-only estimate
 * (Relevant's title, seniority and location parts, #73), shown with "≈". Local and deterministic: nothing is
 * loaded and no model runs.
 */

const WORKPLACE: Record<NonNullable<ExploreJob['workModel']>, WorkplaceType> = {
  Remote: 'Remote',
  Hybrid: 'Hybrid',
  'On Site': 'Onsite'
}

/**
 * The saved job for a listed one: the Jobright page is its URL until the full posting is fetched, and its
 * description is the row's qualifications (#150) until then, so Jobs and Automation score it without loading
 * anything. `descriptionComplete` stays false: the qualifications are a summary, not the posting.
 */
export function toJob(e: ExploreJob, now: Date): Job {
  return {
    id: savedJobId(e.id),
    source: 'jobright',
    sourceId: e.id,
    title: e.title,
    company: e.company,
    location: e.location,
    remote: e.workModel === 'Remote',
    salary: e.salary ?? '',
    // Noon UTC: the posted day reads the same in every time zone.
    postedAt: `${e.postedAt}T12:00:00.000Z`,
    url: e.url,
    boardUrl: e.url,
    description: e.qualifications?.trim() ?? '',
    descriptionComplete: false,
    tags: [],
    fetchedAt: now.toISOString(),
    ...(e.workModel ? { workplaceType: WORKPLACE[e.workModel] } : {})
  }
}

/** A row's score: `exact` from its qualifications, or `estimate` (≈) from its title when it has none. */
export type RowScore =
  | {
      kind: 'exact'
      /** 0–100, the match score (#149) of the saved job. */
      score: number
      matched: MatchSkill[]
      missing: MatchSkill[]
      gates: MatchGate[]
    }
  | {
      kind: 'estimate'
      /** 0–100, `titleEstimate`. */
      score: number
      reasons: string[]
    }

/** Whether a row has qualifications to score from. */
export const hasQualifications = (row: Pick<ExploreJob, 'qualifications'>): boolean => !!row.qualifications?.trim()

/** The score of one row against the profile's signals. `now` only stamps the job, it never changes the score. */
export function scoreRow(row: ExploreJob, s: ProfileSignals, now = new Date()): RowScore {
  const job = toJob(row, now)
  if (hasQualifications(row)) {
    const { score, matched, missing, gates } = scoreJob(job, s, now).match
    return { kind: 'exact', score, matched, missing, gates }
  }
  return { kind: 'estimate', ...titleEstimate(job, s) }
}

/** Every row's score by id: computed once per list and profile (the page memoizes it on both). */
export function scoreRows(rows: readonly ExploreJob[], s: ProfileSignals, now = new Date()): Map<string, RowScore> {
  return new Map(rows.map((r) => [r.id, scoreRow(r, s, now)]))
}
