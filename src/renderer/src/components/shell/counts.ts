import type { RunStatus } from '@shared/runner-types'

export interface NavCounts {
  /** Runs waiting for the user's reply. */
  waiting: number
  /** Runs working right now. */
  running: number
  /** Unattended results waiting on the Review page. */
  review: number
}

/** Counts of live runs by status (pure, for the Tailor badge). */
export function runCounts(statuses: Iterable<RunStatus>): Pick<NavCounts, 'waiting' | 'running'> {
  let waiting = 0
  let running = 0
  for (const s of statuses) {
    if (s === 'waiting') waiting++
    else if (s === 'running') running++
  }
  return { waiting, running }
}

/** The sidebar badge: runs that need you or work now; `null` hides it. */
export function tailorBadge({ waiting, running }: Pick<NavCounts, 'waiting' | 'running'>): { count: number; label: string } | null {
  const count = waiting + running
  if (count === 0) return null
  const parts = [waiting && `${waiting} waiting for your reply`, running && `${running} working`].filter(Boolean)
  return { count, label: parts.join(', ') }
}
