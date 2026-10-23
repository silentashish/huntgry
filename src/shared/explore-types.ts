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

/**
 * The Jobright sign-in of the hidden job-board browser (#146). Signed in, a Jobright posting page carries the
 * employer's own posting link, which then replaces the Jobright page as the saved job's link.
 */
export interface JobrightAccount {
  /** Whether the last Jobright posting page Huntgry loaded was rendered for a signed-in user; `null` = never checked. */
  connected: boolean | null
  /** When that was (ISO), or `null`. */
  checkedAt: string | null
}

export interface ExploreApi {
  /** The cached list; fetched from GitHub when the workspace has none yet. */
  list(): Promise<ExploreList>
  /** Fetches the list from GitHub again and caches it. */
  refresh(): Promise<ExploreList>
  /**
   * Saves a listed job to the Jobs page (idempotent); returns the saved (canonical) job. While Jobright is
   * connected, a new job's link is the employer's posting when Jobright gives one (#146).
   */
  add(id: string): Promise<Job>
  /** The Jobright sign-in as last seen, without loading anything. */
  account(): Promise<JobrightAccount>
  /** Opens Jobright in a sign-in window; resolves when it reports a signed-in user or the window is closed. */
  connect(): Promise<JobrightAccount>
  /** Loads one Jobright posting page to see whether the sign-in still holds. */
  checkAccount(): Promise<JobrightAccount>
  /** Signs the hidden browser out of Jobright (removes its cookies). */
  disconnect(): Promise<JobrightAccount>
}

export const EXPLORE_CHANNELS = {
  list: 'explore:list',
  refresh: 'explore:refresh',
  add: 'explore:add',
  account: 'explore:account',
  connect: 'explore:connect',
  checkAccount: 'explore:check-account',
  disconnect: 'explore:disconnect'
} as const

/** Shape of a Jobright posting id, checked on every id the renderer sends. */
export const JOBRIGHT_ID_PATTERN = /^[A-Za-z0-9]{6,64}$/

/** The id of the saved job for a listed one. */
export const savedJobId = (id: string): string => `jobright:${id}`
