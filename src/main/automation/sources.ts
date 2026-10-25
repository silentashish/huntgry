import type { CandidateInput } from '@shared/automation-select'
import type { ExploreJob } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'

/**
 * Where Automation's candidates come from (#154). A source lists jobs as `CandidateInput`s and turns one into a
 * saved job when a run picks it. Today: saved Jobs, and the Explore cache as it is (never refreshed on a timer).
 * Explore rows have no description yet, so they cannot be scored until their posting is read; once a source can
 * give a row's requirements (#169's qualifications, #150's skills), it sets `job.description` and `scoreable`,
 * and selection scores it like a saved job. Only the source changes, never the selection.
 */
export interface CandidateSource {
  id: string
  list(workspace: string): Promise<CandidateInput[]>
  /** The saved job id for a picked input: itself for a saved job, Explore's "Add to Jobs" for a row. */
  materialize(workspace: string, input: CandidateInput): Promise<string>
}

/** Saved jobs, newest first (dismissed ones are skipped by selection with a reason). */
export function jobsSource(deps: { listJobs(workspace: string): Promise<Job[]> }): CandidateSource {
  return {
    id: 'jobs',
    list: async (ws) =>
      (await deps.listJobs(ws)).map((job) => ({
        key: job.id,
        source: 'jobs',
        job,
        savedJobId: job.id,
        scoreable: job.description.trim().length > 0
      })),
    materialize: async (_ws, input) => input.savedJobId ?? input.job.id
  }
}

export interface ExploreSourceDeps {
  /** The cached rows (`listExplore`); empty when there is no cache. */
  rows(workspace: string): Promise<ExploreJob[]>
  /** The Job a row is saved as (`toJob`). */
  toJob(row: ExploreJob, now: Date): Job
  /** The saved copy of a row, if it was added already (`findCanonical`). */
  saved(workspace: string, savedId: string): Promise<Job | null>
  /** "Add to Jobs" (`addExplore`): saves the row and, while Jobright is connected, resolves its employer link. */
  add(workspace: string, rowId: string): Promise<Job>
  now?: () => Date
}

export const EXPLORE_KEY_PREFIX = 'explore:'

/** The Explore cache's rows; a row already saved is offered as its saved job (with its description, if fetched). */
export function exploreCandidates(deps: ExploreSourceDeps): CandidateSource {
  return {
    id: 'explore',
    list: async (ws) => {
      const now = deps.now?.() ?? new Date()
      const out: CandidateInput[] = []
      for (const row of await deps.rows(ws)) {
        const listed = deps.toJob(row, now)
        const saved = await deps.saved(ws, listed.id).catch(() => null)
        const job = saved ?? listed
        out.push({
          key: saved ? saved.id : `${EXPLORE_KEY_PREFIX}${row.id}`,
          source: 'explore',
          job,
          ...(saved ? { savedJobId: saved.id } : {}),
          scoreable: job.description.trim().length > 0
        })
      }
      return out
    },
    materialize: async (ws, input) => {
      if (input.savedJobId) return input.savedJobId
      const rowId = input.key.startsWith(EXPLORE_KEY_PREFIX) ? input.key.slice(EXPLORE_KEY_PREFIX.length) : input.job.sourceId
      return (await deps.add(ws, rowId)).id
    }
  }
}
