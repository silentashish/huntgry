import type { CandidateInput } from '@shared/automation-select'
import type { ExploreJob } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'

/**
 * Where Automation's candidates come from (#154). A source lists jobs as `CandidateInput`s and turns one into a
 * saved job when a run picks it. Today: saved Jobs, and the Explore cache as it is (never refreshed on a timer).
 * An Explore row's job carries the row's qualifications as its description (#150, `toJob`), so it is `scoreable`
 * and selection scores it like a saved job; a README row has none and is scored once its posting is read. Only
 * the source changes, never the selection.
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
  /** The saved jobs, canonical with their aliases (`listJobs`): read once per list, joined to the rows by id. */
  savedJobs(workspace: string): Promise<Job[]>
  /** "Add to Jobs" (`addExplore`): saves the row (Automation looks its employer link up in its own step). */
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
      const rows = await deps.rows(ws)
      // One read of the saved jobs for the whole list (hundreds of rows), indexed by id and alias.
      const index = new Map<string, Job>()
      if (rows.length > 0) for (const job of await deps.savedJobs(ws).catch(() => [])) for (const id of [job.id, ...(job.aliases ?? [])]) index.set(id, job)
      const out: CandidateInput[] = []
      for (const row of rows) {
        const listed = deps.toJob(row, now)
        const saved = index.get(listed.id) ?? null
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
