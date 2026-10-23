/**
 * Explore (#142): the daily new-grad jobs of Jobright's public GitHub list, read from its README,
 * cached in the workspace (`.huntgry/explore/jobright.json`) and addable to the Jobs page.
 */

import type { Job } from './jobs-types'

/** The list's "Work Model" column. */
export type WorkModel = 'Remote' | 'Hybrid' | 'On Site'

export const WORK_MODELS: readonly WorkModel[] = ['Remote', 'Hybrid', 'On Site']

/** One row of the list. */
export interface ExploreJob {
  /** Jobright's posting id (`jobright.ai/jobs/info/<id>`); the saved job is `jobright:<id>`. */
  id: string
  company: string
  /** The company's site, when the row links one (public http(s) only). */
  companyUrl: string | null
  title: string
  /** `https://jobright.ai/jobs/info/<id>`, tracking parameters removed. */
  url: string
  location: string
  /** `null` when the row's work model is not one of the three. */
  workModel: WorkModel | null
  /** Posted day, `YYYY-MM-DD` (the list gives `Mon D`; the year is inferred). */
  postedAt: string
}

export interface ExploreList {
  jobs: ExploreJob[]
  /** When the list was last fetched from GitHub; `null` when it never was. */
  fetchedAt: string | null
}

export interface ExploreApi {
  /** The cached list; fetched from GitHub when the workspace has none yet. */
  list(): Promise<ExploreList>
  /** Fetches the list from GitHub again and caches it. */
  refresh(): Promise<ExploreList>
  /** Saves a listed job to the Jobs page (idempotent); returns the saved (canonical) job. */
  add(id: string): Promise<Job>
}

export const EXPLORE_CHANNELS = {
  list: 'explore:list',
  refresh: 'explore:refresh',
  add: 'explore:add'
} as const

/** Shape of a Jobright posting id, checked on every id the renderer sends. */
export const JOBRIGHT_ID_PATTERN = /^[A-Za-z0-9]{6,64}$/

/** The id of the saved job for a listed one. */
export const savedJobId = (id: string): string => `jobright:${id}`
