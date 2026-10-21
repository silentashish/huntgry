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
}

export const JOBRIGHT_JOBS: readonly MockJobrightJob[]

/** The mock README, dated relative to `now`, job links on `origin`. */
export function jobrightReadme(origin: string, now?: Date): string

/** A mock Jobright posting page, or `null` for an unknown id. */
export function jobrightPostingPage(id: string): { status: number; html: string } | null
