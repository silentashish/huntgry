import type { ApplicationRecord, ApplicationStatus } from '@shared/applications-types'
import type { UsageDay, UsageFilter, UsageRange } from '@shared/usage-types'
import { isReadyToApply } from './filter'

/** Pure helpers behind the Dashboard header, "Needs you" strip, stat tiles and usage bars (#109). */

/** "Good morning" / "Good afternoon" / "Good evening" for a local hour (0–23). */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** The first word of the master profile's name, or `null` when there is none. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first ? first : null
}

/** "Good morning, Ashish." (or "Good morning." without a name). */
export function greetingLine(now: Date, name: string | null | undefined): string {
  const first = firstNameOf(name)
  return `${greetingFor(now.getHours())}${first ? `, ${first}` : ''}.`
}

/** "Tuesday · 7 Oct" in the user's locale order. */
export function eyebrowDate(now: Date): string {
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' })
  return `${weekday} · ${shortDate(now.toISOString(), now)}`
}

/** "7 Oct" (locale order), with the year when it is not this year's. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The subtitle under the greeting: how many "Needs you" cards there are. */
export function needsYouLine(things: number): string {
  if (things <= 0) return 'Nothing needs you right now. The hound keeps sniffing.'
  return `${things} thing${things === 1 ? '' : 's'} need${things === 1 ? 's' : ''} you before the hunt moves on.`
}

/** Generated results that could be applied to now: not applied yet, resume built, posting known, review passed. */
export function readyToApply(apps: readonly ApplicationRecord[]): ApplicationRecord[] {
  return apps.filter(isReadyToApply)
}

/** "A, B and 2 more" for a list of names. */
export function listNames(names: readonly string[], max = 2): string {
  const unique = [...new Set(names.filter(Boolean))]
  if (unique.length === 0) return ''
  if (unique.length <= max) return unique.length === 2 ? `${unique[0]} and ${unique[1]}` : unique[0]
  return `${unique.slice(0, max).join(', ')} and ${unique.length - max} more`
}

const DAY_MS = 86_400_000

/** Local `YYYY-MM-DD`, the key of `UsageDay.day`. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export type KpiKey = 'total' | Exclude<ApplicationStatus, 'archived'>

/** The muted line under each stat tile, from what the records know; `undefined` = nothing worth saying. */
export function kpiSubs(apps: readonly ApplicationRecord[], now: Date = new Date()): Record<KpiKey, string | undefined> {
  const weekAgo = now.getTime() - 7 * DAY_MS
  const month = dayKey(now).slice(0, 7)
  const of = (s: ApplicationStatus) => apps.filter((a) => a.tracking.status === s)
  const newThisWeek = apps.filter((a) => Date.parse(a.createdAt) >= weekAgo).length
  const built = of('generated').filter((a) => a.files.includes('resume.pdf')).length
  const appliedThisMonth = apps.filter((a) => a.tracking.appliedAt?.startsWith(month)).length
  const offers = of('offer').map((a) => a.company)
  return {
    total: newThisWeek > 0 ? `${newThisWeek} new this week` : undefined,
    generated: built > 0 ? `${built} resume${built === 1 ? '' : 's'} built` : undefined,
    applied: appliedThisMonth > 0 ? `${appliedThisMonth} this month` : undefined,
    // No status history is recorded, so "this week" counts for interviews and rejections are not known.
    interviewing: undefined,
    offer: offers.length > 0 ? listNames(offers, 1) : undefined,
    rejected: undefined
  }
}

/**
 * The status pill of the last pipeline: why it ended (the main process's `stopReason`: Stop, a
 * spend limit, the budget, an agent that could not start) or how it finished (`counts.failed`).
 */
export function pipelineOutcome(summary: { stopReason?: string; counts: { failed: number; total: number } }): {
  label: string
  tone: 'success' | 'warning' | 'danger' | 'neutral'
} {
  const reason = summary.stopReason
  if (reason) {
    if (reason.startsWith('Stopped by you')) return { label: 'Stopped by you', tone: 'neutral' }
    if (reason.includes('spend limit')) return { label: 'Paused: spend limit', tone: 'warning' }
    if (reason.startsWith('Budget reached')) return { label: 'Stopped: budget', tone: 'warning' }
    if (reason.startsWith('Cannot start')) return { label: 'Could not start', tone: 'danger' }
    return { label: 'Stopped', tone: 'warning' }
  }
  const { failed, total } = summary.counts
  if (failed > 0 && failed >= total) return { label: 'Failed', tone: 'danger' }
  if (failed > 0) return { label: `Finished · ${failed} failed`, tone: 'warning' }
  return { label: 'Finished', tone: 'success' }
}

/** Usage filters set behind "Breakdown", which the card header does not show: models, statuses, several agents. */
export function usageHiddenFilters(f: UsageFilter): number {
  return (f.models?.length ? 1 : 0) + (f.statuses?.length ? 1 : 0) + ((f.agents?.length ?? 0) > 1 ? 1 : 0)
}

export interface DayBar {
  day: string
  costUsd: number
  tokens: number
  activeMs: number
  /** Within the last seven days (soft Ember); `today` is solid Ember. */
  recent: boolean
  today: boolean
}

/**
 * One bar per calendar day of the range, empty days included, so the chart reads as time. The bars
 * start on the calendar day the totals start: the main process counts runs created since
 * `now − N × 24 h` (7 or 30 days), which falls inside the day N days ago, so a bounded range shows
 * N + 1 days. "All time" starts on the first day with a turn, at most the last 60 days.
 */
export function dayBars(byDay: readonly UsageDay[], range: UsageRange | undefined, now: Date = new Date()): DayBar[] {
  const values = new Map(byDay.map((d) => [d.day, d]))
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const parse = (key: string) => {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  let first: Date
  if (range === '7d' || range === '30d') {
    const since = new Date(now.getTime() - (range === '7d' ? 7 : 30) * DAY_MS)
    first = new Date(since.getFullYear(), since.getMonth(), since.getDate())
    // A turn can only start after its run was created, so no day is older than this; keep any that is.
    if (byDay.length > 0 && parse(byDay[0].day) < first) first = parse(byDay[0].day)
  } else {
    if (byDay.length === 0) return []
    first = parse(byDay[0].day)
    const floor = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 59)
    if (first < floor) first = floor
  }
  const out: DayBar[] = []
  for (let date = first; date <= today; date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)) {
    const key = dayKey(date)
    const v = values.get(key)
    const back = Math.round((today.getTime() - date.getTime()) / DAY_MS)
    out.push({
      day: key,
      costUsd: v?.estimatedCostUsd ?? 0,
      tokens: v?.tokens ?? 0,
      activeMs: v?.activeMs ?? 0,
      recent: back < 7,
      today: back === 0
    })
  }
  return out
}
