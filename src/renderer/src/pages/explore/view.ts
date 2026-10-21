import type { ExploreJob, WorkModel } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'

/** One posted day of the list: `YYYY-MM-DD` and how many jobs went up that day. */
export interface DayGroup {
  day: string
  count: number
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` of a date in local time (the list's days are local days). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The days of the list with their counts, newest first. */
export function dayGroups(jobs: readonly ExploreJob[]): DayGroup[] {
  const counts = new Map<string, number>()
  for (const j of jobs) counts.set(j.postedAt, (counts.get(j.postedAt) ?? 0) + 1)
  return [...counts].map(([day, count]) => ({ day, count })).sort((a, b) => b.day.localeCompare(a.day))
}

/** The day shown first: today when the list has jobs from today, else its newest day; `null` when empty. */
export function defaultDay(groups: readonly DayGroup[], now = new Date()): string | null {
  const today = localDay(now)
  return groups.find((g) => g.day === today)?.day ?? groups[0]?.day ?? null
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Today", "Yesterday", else "Oct 19" (with the year when it is not this year's). */
export function dayLabel(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = localDay(now)
  if (day === today) return 'Today'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (day === localDay(yesterday)) return 'Yesterday'
  const label = `${MONTH[date.getMonth()]} ${date.getDate()}`
  return y === now.getFullYear() ? label : `${label}, ${y}`
}

export type WorkModelFilter = WorkModel | 'all'

/** The jobs of `day` that match the text (company, title, location) and the work model. */
export function visibleRows(
  jobs: readonly ExploreJob[],
  { day, text, workModel }: { day: string | null; text: string; workModel: WorkModelFilter }
): ExploreJob[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return jobs.filter((j) => {
    if (day && j.postedAt !== day) return false
    if (workModel !== 'all' && j.workModel !== workModel) return false
    const hay = `${j.company} ${j.title} ${j.location}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Saved job of each listed id already on the Jobs page (its own record, or merged into another board's copy). */
export function addedJobs(saved: readonly Job[]): Map<string, Job> {
  const out = new Map<string, Job>()
  for (const j of saved) {
    for (const id of [j.id, ...(j.aliases ?? [])]) {
      if (id.startsWith('jobright:')) out.set(id.slice('jobright:'.length), j)
    }
  }
  return out
}

/** "Updated just now" / "Updated 5 min ago" / "Updated 3 h ago" / "Updated 2 days ago"; `Never updated` when unknown. */
export function updatedAgo(fetchedAt: string | null, now = Date.now()): string {
  if (!fetchedAt) return 'Never updated'
  const t = new Date(fetchedAt).getTime()
  if (Number.isNaN(t)) return 'Never updated'
  const min = Math.floor((now - t) / 60_000)
  if (min < 1) return 'Updated just now'
  if (min < 60) return `Updated ${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `Updated ${h} h ago`
  const days = Math.floor(h / 24)
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`
}
