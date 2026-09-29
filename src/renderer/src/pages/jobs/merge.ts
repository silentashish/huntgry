import type { Job } from '@shared/jobs-types'

/**
 * Merges freshly returned jobs into the list on screen, newest first. The
 * canonical id of a job seen on several boards can change between searches,
 * so each incoming job also drops its other copies: its aliases, and any card
 * that listed it as an alias.
 */
export function mergeJobs(current: readonly Job[], incoming: readonly Job[]): Job[] {
  const byId = new Map(current.map((j) => [j.id, j]))
  for (const j of incoming) {
    for (const alias of j.aliases ?? []) byId.delete(alias)
    for (const [id, old] of byId) if (old.aliases?.includes(j.id)) byId.delete(id)
    byId.set(j.id, j)
  }
  return [...byId.values()].sort((a, b) => (b.postedAt ?? b.fetchedAt).localeCompare(a.postedAt ?? a.fetchedAt))
}
