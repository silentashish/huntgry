import type { BoardCard, BoardColumnId } from '@shared/board'

/**
 * A Board column's cards grouped by the week of their last change (#160): "This week", "Last
 * week", then "Oct 5 – 11", newest first. Weeks start on the locale's first day of the week and
 * are counted in local time. Pure, with `now` and the locale injectable, for tests.
 */

export interface WeekOptions {
  now?: Date
  /** BCP 47 tag; the runtime's default locale when left out. */
  locale?: string
  /** First day of the week, 0 = Sunday … 6 = Saturday; the locale's when left out. */
  firstDay?: number
}

export interface WeekGroup {
  /** The week's first day, `YYYY-MM-DD` in local time; `undated` for cards with no readable time. */
  key: string
  label: string
  /** This week (or later): shown open and with full cards. */
  current: boolean
  cards: BoardCard[]
}

/** Monday: the ISO 8601 week, when the runtime cannot say what the locale uses. */
const FALLBACK_FIRST_DAY = 1

interface WeekInfo {
  /** 1 = Monday … 7 = Sunday. */
  firstDay: number
}

/** The locale's first day of the week, 0 = Sunday … 6 = Saturday (`Intl.Locale` week info). */
export function firstDayOfWeek(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      getWeekInfo?(): WeekInfo
      weekInfo?: WeekInfo
    }
    const info = loc.getWeekInfo?.() ?? loc.weekInfo
    if (info && Number.isInteger(info.firstDay) && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7
  } catch {
    // An unknown tag: fall through.
  }
  return FALLBACK_FIRST_DAY
}

/** Local midnight of the first day of `date`'s week. Calendar arithmetic, so DST days are no trouble. */
export function startOfWeek(date: Date, firstDay: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() - ((d.getDay() - firstDay + 7) % 7))
  return d
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** `YYYY-MM-DD` as local midnight (`Date.parse` would read it as UTC). */
function localDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(iso)
}

/**
 * When a card last changed, in ms (NaN when unknown): the time the board sorts by (`card.at`), or
 * a later status change the scan does not count as one, such as the day it was applied.
 */
export function lastChange(card: BoardCard): number {
  const times = [Date.parse(card.at)]
  if (card.kind === 'application') {
    const t = card.app.tracking
    if (card.column === 'applied' && t.appliedAt) times.push(localDay(t.appliedAt))
    if (card.column === 'archived' && t.archivedAt) times.push(Date.parse(t.archivedAt))
  }
  const ok = times.filter(Number.isFinite)
  return ok.length > 0 ? Math.max(...ok) : NaN
}

/** "This week", "Last week", "Oct 5 – 11", "Sep 28 – Oct 4", "Dec 29, 2025 – Jan 4, 2026". */
export function weekLabel(start: Date, thisWeek: Date, locale?: string): string {
  const weeksAgo = Math.round((thisWeek.getTime() - start.getTime()) / (7 * 86_400_000))
  if (weeksAgo <= 0) return 'This week'
  if (weeksAgo === 1) return 'Last week'
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, o).format(d)
  const yearOf = start.getFullYear() !== thisWeek.getFullYear() || end.getFullYear() !== start.getFullYear()
  if (yearOf) {
    const o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
    return `${fmt(start, o)} – ${fmt(end, o)}`
  }
  const sameMonth = start.getMonth() === end.getMonth()
  return `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(end, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`
}

/**
 * `cards` in week groups, newest week first and newest card first inside each. Cards dated after
 * this week count as this week; cards with no readable time go last, under "Undated".
 */
export function weekGroups(cards: readonly BoardCard[], opts: WeekOptions = {}): WeekGroup[] {
  const now = opts.now ?? new Date()
  const firstDay = opts.firstDay ?? firstDayOfWeek(opts.locale)
  const thisWeek = startOfWeek(now, firstDay)
  const groups = new Map<string, { start: number; cards: { card: BoardCard; t: number }[] }>()
  for (const card of cards) {
    const t = lastChange(card)
    const start = Number.isFinite(t) ? Math.min(startOfWeek(new Date(t), firstDay).getTime(), thisWeek.getTime()) : -Infinity
    const key = Number.isFinite(start) ? dayKey(new Date(start)) : 'undated'
    const g = groups.get(key) ?? { start, cards: [] }
    g.cards.push({ card, t })
    groups.set(key, g)
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => b.start - a.start)
    .map(([key, g]) => ({
      key,
      label: key === 'undated' ? 'Undated' : weekLabel(new Date(g.start), thisWeek, opts.locale),
      current: g.start === thisWeek.getTime(),
      cards: g.cards
        .sort((a, b) => (b.t || 0) - (a.t || 0) || a.card.key.localeCompare(b.card.key))
        .map((c) => c.card)
    }))
}

/** A group's fold state is remembered per column and week. */
export const foldKey = (column: BoardColumnId, week: string) => `${column}:${week}`

/** Whether a group is folded: what the user chose, else open for this week and folded before. */
export function isFolded(folds: Readonly<Record<string, boolean>>, column: BoardColumnId, group: WeekGroup): boolean {
  return folds[foldKey(column, group.key)] ?? !group.current
}
