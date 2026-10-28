import type { ReactNode } from 'react'
import type { Job } from '@shared/jobs-types'
import type { JobsTab, PageParams } from '../../navigation'

/**
 * The Jobs page's two tabs (#189): Discover (Jobright's daily list, the old Explore page) and Saved (the jobs you
 * keep). Pure, so the tab the page opens on is unit-tested.
 */

/** What a tab puts in the page header; the page adds the title, "Add job" and the tab switch. */
export interface TabHeader {
  eyebrow: ReactNode
  subtitle: ReactNode
  actions?: ReactNode
}

/** Saved jobs still in play, for "Saved (n)": dismissed ones are left out (they have their own segment). */
export function savedCount(jobs: readonly Pick<Job, 'dismissed'>[]): number {
  return jobs.filter((j) => !j.dismissed).length
}

/**
 * The tab the page opens on: Saved when a saved job is to be opened (`openId`), else the one asked for (`tab`),
 * else Saved when there is a saved job in play and Discover when there is none (a first visit finds something to
 * look at). `null` while the saved jobs are still loading and nothing was asked for.
 */
export function jobsTab(params: PageParams['jobs'], saved: number | null): JobsTab | null {
  if (params?.openId) return 'saved'
  if (params?.tab) return params.tab
  if (saved === null) return null
  return saved > 0 ? 'saved' : 'discover'
}
