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
}

export const JOBRIGHT_JOBS: readonly MockJobrightJob[]

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
