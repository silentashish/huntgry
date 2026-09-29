import type { ApplicationRecord, ApplicationStatus } from '@shared/applications-types'

export type SortKey = 'newest' | 'oldest' | 'company'

export interface Filter {
  text: string
  /** Empty = every status except archived. */
  statuses: ApplicationStatus[]
  sort: SortKey
}

export const DEFAULT_FILTER: Filter = { text: '', statuses: [], sort: 'newest' }

/** Applies the dashboard's search, status filter and sort. Pure, for tests and `useMemo`. */
export function filterApplications(apps: readonly ApplicationRecord[], f: Filter): ApplicationRecord[] {
  const q = f.text.trim().toLowerCase()
  const out = apps.filter((a) => {
    const statusOk = f.statuses.length > 0 ? f.statuses.includes(a.tracking.status) : a.tracking.status !== 'archived'
    if (!statusOk) return false
    if (!q) return true
    return [a.company, a.role, a.jobTitle, a.jobId, a.tracking.notes].some((s) => s.toLowerCase().includes(q))
  })
  const byDate = (a: ApplicationRecord, b: ApplicationRecord) => a.createdAt.localeCompare(b.createdAt)
  if (f.sort === 'newest') out.sort((a, b) => byDate(b, a))
  else if (f.sort === 'oldest') out.sort(byDate)
  else out.sort((a, b) => a.company.localeCompare(b.company) || byDate(b, a))
  return out
}

/** Applications per status, for the summary cards. */
export function countByStatus(apps: readonly ApplicationRecord[]): Record<ApplicationStatus, number> {
  const counts = { generated: 0, applied: 0, interviewing: 0, offer: 0, rejected: 0, archived: 0 }
  for (const a of apps) counts[a.tracking.status]++
  return counts
}
