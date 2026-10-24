import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApplicationRecord } from '@shared/applications-types'
import { buildBoard, type BoardCard } from '@shared/board'
import { firstDayOfWeek, foldKey, isFolded, lastChange, startOfWeek, weekGroups, weekLabel } from './weeks'

// Week boundaries are local time: pin a zone with DST so the boundary cases mean the same everywhere.
const TZ = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
afterAll(() => {
  process.env.TZ = TZ
})

/** Local time in the pinned zone. */
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h)
const SUNDAY = 0
const MONDAY = 1

const app = (id: string, updatedAt: Date | string, tracking: Partial<ApplicationRecord['tracking']> = {}): ApplicationRecord => ({
  id: `software-engineer/acme/${id}`,
  role: 'Software Engineer',
  company: 'Acme',
  jobId: id,
  jobTitle: `Role ${id}`,
  jobUrl: null,
  createdAt: typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString(),
  updatedAt: typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString(),
  files: [],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  tracking: { status: 'applied', notes: '', ...tracking }
})

const cardsOf = (apps: ApplicationRecord[], now: Date): BoardCard[] =>
  buildBoard({ jobs: [], applications: apps, queue: [], now }).columns.flatMap((c) => c.cards)

describe('firstDayOfWeek', () => {
  it("reads the locale's week info: Sunday in the US, Monday in Germany and the UK", () => {
    expect(firstDayOfWeek('en-US')).toBe(SUNDAY)
    expect(firstDayOfWeek('de-DE')).toBe(MONDAY)
    expect(firstDayOfWeek('en-GB')).toBe(MONDAY)
  })
  it('falls back to Monday (ISO 8601) for a tag it cannot read', () => {
    expect(firstDayOfWeek('not a locale!')).toBe(MONDAY)
  })
})

describe('startOfWeek', () => {
  it('is local midnight of the first day, by the first day of the week', () => {
    const wed = local(2026, 10, 21)
    expect(startOfWeek(wed, SUNDAY)).toEqual(local(2026, 10, 18, 0))
    expect(startOfWeek(wed, MONDAY)).toEqual(local(2026, 10, 19, 0))
    // Sunday itself: the first day of a Sunday week, the last of a Monday week.
    expect(startOfWeek(local(2026, 10, 18), SUNDAY)).toEqual(local(2026, 10, 18, 0))
    expect(startOfWeek(local(2026, 10, 18), MONDAY)).toEqual(local(2026, 10, 12, 0))
  })

  it('holds across the DST changes (the day has 23 or 25 hours)', () => {
    // US DST ends Sunday 2026-11-01 and starts Sunday 2026-03-08.
    expect([local(2026, 10, 31).getTimezoneOffset(), local(2026, 11, 2).getTimezoneOffset()]).toEqual([240, 300])
    expect(startOfWeek(local(2026, 11, 4, 23), SUNDAY)).toEqual(local(2026, 11, 1, 0))
    expect(startOfWeek(local(2026, 11, 1, 0), MONDAY)).toEqual(local(2026, 10, 26, 0))
    expect(startOfWeek(local(2026, 3, 9, 0), SUNDAY)).toEqual(local(2026, 3, 8, 0))
    expect(startOfWeek(local(2026, 3, 14, 23), MONDAY)).toEqual(local(2026, 3, 9, 0))
  })

  it('crosses the year boundary', () => {
    expect(startOfWeek(local(2027, 1, 1), MONDAY)).toEqual(local(2026, 12, 28, 0))
    expect(startOfWeek(local(2027, 1, 1), SUNDAY)).toEqual(local(2026, 12, 27, 0))
  })
})

describe('weekLabel', () => {
  const thisWeek = local(2026, 10, 18, 0)
  it('names this week and last week, then the dates', () => {
    expect(weekLabel(local(2026, 10, 18, 0), thisWeek, 'en-US')).toBe('This week')
    expect(weekLabel(local(2026, 10, 11, 0), thisWeek, 'en-US')).toBe('Last week')
    expect(weekLabel(local(2026, 10, 4, 0), thisWeek, 'en-US')).toBe('Oct 4 – 10')
    expect(weekLabel(local(2026, 9, 27, 0), thisWeek, 'en-US')).toBe('Sep 27 – Oct 3')
  })
  it('counts last week right across DST and the year, and adds the year when it differs', () => {
    expect(weekLabel(local(2026, 10, 25, 0), local(2026, 11, 1, 0), 'en-US')).toBe('Last week')
    expect(weekLabel(local(2026, 12, 28, 0), local(2027, 1, 4, 0), 'en-US')).toBe('Last week')
    expect(weekLabel(local(2026, 12, 21, 0), local(2027, 1, 4, 0), 'en-US')).toBe('Dec 21, 2026 – Dec 27, 2026')
    expect(weekLabel(local(2026, 12, 28, 0), local(2027, 1, 11, 0), 'en-US')).toBe('Dec 28, 2026 – Jan 3, 2027')
  })
  it("uses the locale's month names", () => {
    expect(weekLabel(local(2026, 10, 5, 0), local(2026, 10, 19, 0), 'de-DE')).toBe('5. Okt. – 11')
  })
})

describe('weekGroups', () => {
  const now = local(2026, 10, 21) // a Wednesday

  it('groups newest week first, newest card first, and only this week is current', () => {
    const cards = cardsOf(
      [
        app('a', local(2026, 10, 19, 9)),
        app('b', local(2026, 10, 20, 9)),
        app('c', local(2026, 10, 13)),
        app('d', local(2026, 10, 1)),
        app('e', local(2026, 10, 2))
      ],
      now
    )
    const groups = weekGroups(cards, { now, locale: 'en-US' })
    expect(groups.map((g) => [g.key, g.label, g.current, g.cards.map((c) => c.title)])).toEqual([
      ['2026-10-18', 'This week', true, ['Role b', 'Role a']],
      ['2026-10-11', 'Last week', false, ['Role c']],
      ['2026-09-27', 'Sep 27 – Oct 3', false, ['Role e', 'Role d']]
    ])
  })

  it("splits on the locale's first day: a Sunday card is this week in the US, last week in Germany", () => {
    const sunday = cardsOf([app('s', local(2026, 10, 18, 9))], now)
    expect(weekGroups(sunday, { now, locale: 'en-US' })[0].label).toBe('This week')
    expect(weekGroups(sunday, { now, locale: 'de-DE' })[0].label).toBe('Last week')
    expect(weekGroups(sunday, { now, firstDay: MONDAY })[0].key).toBe('2026-10-12')
  })

  it('takes a later status change as the last change, and keeps future and undated cards in sight', () => {
    // Applied today, though its files are from three weeks ago.
    const moved = app('m', local(2026, 9, 30), { appliedAt: '2026-10-21' })
    expect(lastChange(cardsOf([moved], now)[0])).toBe(local(2026, 10, 21, 0).getTime())
    // Moved to Offer, Interviewing, Rejected or back to Ready today: the status change dates it.
    for (const status of ['offer', 'interviewing', 'rejected', 'generated'] as const) {
      const card = cardsOf([app('o', local(2026, 9, 1), { status, statusChangedAt: local(2026, 10, 21, 9).toISOString() })], now)[0]
      expect(weekGroups([card], { now, locale: 'en-US' })[0].label).toBe('This week')
    }
    // Reviewed today, a run's result moves to Ready to apply.
    const reviewed = app('r', local(2026, 9, 1), {
      status: 'generated',
      review: { state: 'approved', runId: 'r', at: local(2026, 9, 1).toISOString(), reviewedAt: local(2026, 10, 20).toISOString() }
    })
    expect(weekGroups(cardsOf([reviewed], now), { now, locale: 'en-US' })[0].label).toBe('This week')
    const cards = cardsOf([moved, app('f', local(2026, 11, 2)), app('u', 'unknown')], now)
    const groups = weekGroups(cards, { now, locale: 'en-US' })
    expect(groups.map((g) => [g.label, g.cards.map((c) => c.title)])).toEqual([
      ['This week', ['Role f', 'Role m']],
      ['Undated', ['Role u']]
    ])
  })
})

describe('lastChange of a saved job', () => {
  it('is its restore from Archived or its tailoring when later than when it was saved', () => {
    const now = local(2026, 10, 21)
    const job = {
      id: 'url:j',
      source: 'url' as const,
      sourceId: 'j',
      title: 'Backend Engineer',
      company: 'Acme',
      location: '',
      remote: false,
      salary: '',
      postedAt: null,
      url: 'https://jobs.example.com/j',
      boardUrl: null,
      description: '',
      descriptionComplete: true,
      tags: [],
      fetchedAt: local(2026, 9, 1).toISOString()
    }
    const at = (j: typeof job & { restoredAt?: string; tailoredAt?: string }) =>
      lastChange(buildBoard({ jobs: [j], applications: [], queue: [], now }).columns[0].cards[0])
    expect(at(job)).toBe(local(2026, 9, 1).getTime())
    expect(at({ ...job, restoredAt: local(2026, 10, 21, 8).toISOString() })).toBe(local(2026, 10, 21, 8).getTime())
    expect(at({ ...job, tailoredAt: local(2026, 10, 19).toISOString() })).toBe(local(2026, 10, 19).getTime())
  })
})

describe('isFolded', () => {
  it('is open for this week and folded before, unless the user chose otherwise for that column and week', () => {
    const [current, past] = weekGroups(cardsOf([app('a', local(2026, 10, 20)), app('b', local(2026, 10, 1))], local(2026, 10, 21)), {
      now: local(2026, 10, 21),
      firstDay: SUNDAY
    })
    expect(isFolded({}, 'applied', current)).toBe(false)
    expect(isFolded({}, 'applied', past)).toBe(true)
    const folds = { [foldKey('applied', past.key)]: false, [foldKey('applied', current.key)]: true }
    expect(isFolded(folds, 'applied', past)).toBe(false)
    expect(isFolded(folds, 'applied', current)).toBe(true)
    expect(isFolded(folds, 'rejected', past)).toBe(true)
  })
})
