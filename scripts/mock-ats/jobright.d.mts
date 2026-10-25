/** A row of the mock Jobright list (`company: '↳'` repeats the previous row's company). */
export interface MockJobrightJob {
  id: string
  company: string
  site?: string
  title: string
  location: string
  work: 'Remote' | 'Hybrid' | 'On Site'
  daysAgo: number
  blocked?: boolean
  /** Path of the employer's posting a signed-in page links (#146). */
  employer?: string
  /** Older than the README's few days: listed by the API only (#169). */
  apiOnly?: boolean
  /** The API's per-job fields (#169). */
  api?: { salary?: string; h1bSponsored?: string; industry?: string[]; companySize?: string }
}

export const JOBRIGHT_JOBS: readonly MockJobrightJob[]

/** The category of `JOBRIGHT_JOBS` (#169). */
export const JOBRIGHT_CATEGORY: string

/** `newgrad:us:data_analysis`'s jobs (#169). */
export const JOBRIGHT_OTHER_JOBS: readonly MockJobrightJob[]

/** The newgrad-jobs API's answer for `body.category`, paged by `position` / `count` (#169). */
export function jobrightApi(body: unknown, position: number, count: number, now?: Date): unknown

/** The mock README, dated relative to `now`, job links on `origin`. */
export function jobrightReadme(origin: string, now?: Date): string

/** The mock sign-in cookie's name (#146). */
export const JOBRIGHT_SESSION_COOKIE: string

/** The mock sign-in page: one button that posts to `/jobright/signin` and goes back to `next`. */
export function jobrightSignInPage(next: string): string

/** A mock Jobright posting page, or `null` for an unknown id; signed in, it links the employer's posting on `employerOrigin`. */
export function jobrightPostingPage(
  id: string,
  opts?: { signedIn?: boolean; employerOrigin?: string }
): { status: number; html: string } | null
