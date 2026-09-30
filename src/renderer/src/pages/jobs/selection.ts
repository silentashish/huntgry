import { canFetchDetails, type Job } from '@shared/jobs-types'
import { ACTIVE_STATUSES, type QueueItem } from '@shared/queue-types'

/** Jobs ticked for bulk tailoring, as a set of job ids. Pure helpers, so the page stays simple. */

/** Dismissed jobs are not tailored. */
export const selectable = (job: Job): boolean => !job.dismissed

export function toggle(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Adds every selectable job of the shown list. */
export function selectAll(sel: ReadonlySet<string>, shown: readonly Job[]): Set<string> {
  return new Set([...sel, ...shown.filter(selectable).map((j) => j.id)])
}

/** The selected jobs among those shown (a job filtered out of view is never tailored by accident). */
export function selectedJobs(sel: ReadonlySet<string>, shown: readonly Job[]): Job[] {
  return shown.filter((j) => selectable(j) && sel.has(j.id))
}

/** State of the "select all shown" box. */
export function selectAllState(sel: ReadonlySet<string>, shown: readonly Job[]): 'all' | 'some' | 'none' {
  const candidates = shown.filter(selectable)
  const n = candidates.filter((j) => sel.has(j.id)).length
  return n === 0 ? 'none' : n === candidates.length ? 'all' : 'some'
}

/** What the confirmation says about the selection. */
export function selectionSummary(jobs: readonly Job[]): {
  total: number
  /** Only a board summary saved; Huntgry tries the employer page first. */
  summaryOnly: number
  /** Only a summary and no page Huntgry can read (Indeed): these fail. */
  unreadable: number
  alreadyTailored: number
} {
  return {
    total: jobs.length,
    summaryOnly: jobs.filter((j) => !j.descriptionComplete).length,
    unreadable: jobs.filter((j) => !j.descriptionComplete && !canFetchDetails(j)).length,
    alreadyTailored: jobs.filter((j) => j.tailoredAt).length
  }
}

/** The unfinished queue item of each job (by canonical id and aliases), for the card badges. */
export function activeQueueItems(items: readonly QueueItem[]): Map<string, QueueItem> {
  const map = new Map<string, QueueItem>()
  for (const i of items) if (ACTIVE_STATUSES.includes(i.status)) map.set(i.jobId, i)
  return map
}
