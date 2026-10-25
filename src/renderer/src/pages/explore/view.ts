import {
  DEFAULT_EXPLORE_CATEGORY,
  EXPLORE_CATEGORIES,
  EXPLORE_MAX_ROWS,
  isExploreCategory,
  type ExploreJob,
  type ExploreList,
  type WorkModel
} from '@shared/explore-types'
import { salaryRange } from '@shared/job-filters'
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

/** Days shown before the rest are folded under "Earlier" (#169: the API list goes back weeks). */
export const RECENT_DAYS = 7

/** The newest `RECENT_DAYS` days, and the older ones that fold. */
export function splitDays(groups: readonly DayGroup[]): { recent: DayGroup[]; older: DayGroup[] } {
  return { recent: groups.slice(0, RECENT_DAYS), older: groups.slice(RECENT_DAYS) }
}

export type WorkModelFilter = WorkModel | 'all'

/** H1B sponsorship (#169): any, `Yes` only, or anything but `No`. */
export type H1bFilter = 'all' | 'yes' | 'not-no'

export interface ExploreFilters {
  text: string
  workModel: WorkModelFilter
  h1b: H1bFilter
  /** Yearly pay the top of the range must reach; `null` for none. */
  minSalary: number | null
}

export const NO_FILTERS: ExploreFilters = { text: '', workModel: 'all', h1b: 'all', minSalary: null }

/**
 * The jobs of `day` that match the text (company, title, location, industry), the work model, the H1B choice and
 * the minimum salary. A job with no H1B answer passes "not No"; one with no readable pay fails a minimum.
 */
export function visibleRows(jobs: readonly ExploreJob[], { day, ...f }: { day: string | null } & Partial<ExploreFilters>): ExploreJob[] {
  const words = (f.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return jobs.filter((j) => {
    if (day && j.postedAt !== day) return false
    if (f.workModel && f.workModel !== 'all' && j.workModel !== f.workModel) return false
    if (f.h1b === 'yes' && j.h1b !== 'Yes') return false
    if (f.h1b === 'not-no' && j.h1b === 'No') return false
    if (f.minSalary) {
      const pay = salaryRange({ salary: j.salary ?? '' })
      if (!pay || pay.max < f.minSalary) return false
    }
    const hay = `${j.company} ${j.title} ${j.location} ${(j.industry ?? []).join(' ')}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Filters that only API rows can answer: off for a README list. */
export function effectiveFilters(f: ExploreFilters, source: ExploreList['source'] | undefined): ExploreFilters {
  return source === 'readme' ? { ...f, h1b: 'all', minSalary: null } : f
}

/** The remembered category and the "Earlier" days' fold, in localStorage like the Board's folds (#160). */
export const CATEGORY_STORAGE_KEY = 'huntgry-explore-category'
export const EARLIER_STORAGE_KEY = 'huntgry-explore-earlier-open'

export function readCategory(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage): string {
  try {
    const c = storage?.getItem(CATEGORY_STORAGE_KEY)
    return isExploreCategory(c) ? c : DEFAULT_EXPLORE_CATEGORY
  } catch {
    return DEFAULT_EXPLORE_CATEGORY
  }
}

export function readFlag(key: string, storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(key) === '1'
  } catch {
    return false
  }
}

export function writePref(key: string, value: string, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Storage full or unavailable: the choice holds until the page is left.
  }
}

/** "Software Engineering" of `newgrad:us:swe`. */
export const categoryLabel = (id: string): string => EXPLORE_CATEGORIES.find((c) => c.id === id)?.label ?? id

/** The category picker's options, grouped ("New grad · US", …). */
export function categoryOptions(): { group: string; items: { value: string; label: string }[] }[] {
  const groups = new Map<string, { value: string; label: string }[]>()
  for (const c of EXPLORE_CATEGORIES) groups.set(c.group, [...(groups.get(c.group) ?? []), { value: c.id, label: c.label }])
  return [...groups].map(([group, items]) => ({ group, items }))
}

const jobsCount = (n: number) => `${n.toLocaleString('en-US')} job${n === 1 ? '' : 's'}`

/**
 * Which source the list shows, and how much of it: "newgrad-jobs API · newest 1,000 of 2,116 jobs" when the category
 * has more than one refresh fetches (the API's total also counts rows Huntgry dropped, so it is shown only then).
 */
export function sourceLabel(list: Pick<ExploreList, 'source' | 'jobs' | 'total'>): string {
  const n = list.jobs.length
  if (list.source === 'readme') return `Jobright's GitHub list (fallback) · ${jobsCount(n)}`
  return list.total && list.total > EXPLORE_MAX_ROWS
    ? `newgrad-jobs API · newest ${n.toLocaleString('en-US')} of ${jobsCount(list.total)}`
    : `newgrad-jobs API · ${jobsCount(n)}`
}

/** `$150000-$168000/yr` → `$150k–$168k/yr`; other pay text as it is. */
export function shortSalary(salary: string): string {
  return salary.replace(/\$(\d{4,})/g, (_, n: string) => `$${Math.round(Number(n) / 1000)}k`).replace(/-\$/g, '–$')
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
