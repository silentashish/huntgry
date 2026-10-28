import { savedJobId, type ExploreJob } from './explore-types'
import { scoreJob, titleEstimate, type JobScore, type ProfileSignals } from './job-relevance'
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

/** Whether a saved job has a description to match (a row saved from the GitHub README has none, #150). */
export const hasDescription = (job: Pick<Job, 'description'>): boolean => !!job.description.trim()

/**
 * The match score of a saved job (#189: the one number both Jobs tabs, the drawer and the Board show): `exact`
 * from its description, or the title-only `estimate` (≈) when it has none, the way its Discover row was scored.
 * `scored` reuses a `scoreJob` result the caller already has (the Saved tab scores every job once for Relevant).
 */
export function jobMatch(job: Job, s: ProfileSignals, scored?: JobScore, now = new Date()): RowScore {
  if (hasDescription(job)) {
    const { score, matched, missing, gates } = (scored ?? scoreJob(job, s, now)).match
    return { kind: 'exact', score, matched, missing, gates }
  }
  return { kind: 'estimate', ...titleEstimate(job, s) }
}

/**
 * The score of one row against the profile's signals: the `jobMatch` of the job it is saved as, so a row and its
 * saved job show the same number. `now` only stamps the job, it never changes the score.
 */
export function scoreRow(row: ExploreJob, s: ProfileSignals, now = new Date()): RowScore {
  return jobMatch(toJob(row, now), s, undefined, now)
}

/** Every row's score by id: computed once per list and profile (the page memoizes it on both). */
export function scoreRows(rows: readonly ExploreJob[], s: ProfileSignals, now = new Date()): Map<string, RowScore> {
  return new Map(rows.map((r) => [r.id, scoreRow(r, s, now)]))
}
