import { describe, expect, it } from 'vitest'
import { NUDGE_RULES, nudgeDelay, parseNudgeState, recordEngaged, recordLaunch, recordNudge, shouldNudge, type NudgeState } from './coffee'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const T0 = Date.UTC(2026, 9, 1)

/** A user who installed 10 days ago and launched 5 times; never nudged, never clicked. */
const settled = (over: Partial<NudgeState> = {}): NudgeState => ({ firstSeenAt: T0, launches: 5, lastNudgeAt: null, lastEngagedAt: null, ...over })
const now = T0 + 10 * DAY
/** 20 minutes into the session. */
const session = now - 20 * MINUTE

describe('coffee nudge schedule (#185)', () => {
  it('plays for a settled user well into a session', () => {
    expect(shouldNudge(settled(), now, session)).toBe(true)
  })

  it('never plays in the first launches', () => {
    expect(shouldNudge(settled({ launches: 1 }), now, session)).toBe(false)
    expect(shouldNudge(settled({ launches: NUDGE_RULES.minLaunches - 1 }), now, session)).toBe(false)
    expect(shouldNudge(settled({ launches: NUDGE_RULES.minLaunches }), now, session)).toBe(true)
  })

  it('never plays in the first days after install, however many launches', () => {
    const young = settled({ firstSeenAt: now - NUDGE_RULES.minAgeMs + 1, launches: 30 })
    expect(shouldNudge(young, now, session)).toBe(false)
    expect(shouldNudge(settled({ firstSeenAt: now - NUDGE_RULES.minAgeMs }), now, session)).toBe(true)
  })

  it('never plays in the first minutes of a session', () => {
    expect(shouldNudge(settled(), now, now)).toBe(false)
    expect(shouldNudge(settled(), now, now - NUDGE_RULES.minSessionMs + 1)).toBe(false)
    expect(shouldNudge(settled(), now, now - NUDGE_RULES.minSessionMs)).toBe(true)
  })

  it('plays at most once per cooldown', () => {
    expect(shouldNudge(settled({ lastNudgeAt: now - DAY }), now, session)).toBe(false)
    expect(shouldNudge(settled({ lastNudgeAt: now - NUDGE_RULES.cooldownMs + 1 }), now, session)).toBe(false)
    expect(shouldNudge(settled({ lastNudgeAt: now - NUDGE_RULES.cooldownMs }), now, session)).toBe(true)
  })

  it('backs off for much longer after a click or a dismissal', () => {
    expect(NUDGE_RULES.engagedCooldownMs).toBeGreaterThan(4 * NUDGE_RULES.cooldownMs)
    const later = now + 30 * DAY
    const engaged = recordEngaged(settled(), now)
    expect(shouldNudge(engaged, later, later - 20 * MINUTE)).toBe(false)
    const muchLater = now + NUDGE_RULES.engagedCooldownMs
    expect(shouldNudge(engaged, muchLater, muchLater - 20 * MINUTE)).toBe(true)
  })

  it('records launches, nudges and engagement without touching the rest', () => {
    const first = recordLaunch(null, T0)
    expect(first).toEqual({ firstSeenAt: T0, launches: 1, lastNudgeAt: null, lastEngagedAt: null })
    const second = recordLaunch(first, T0 + DAY)
    expect(second).toEqual({ ...first, launches: 2 })
    expect(recordNudge(second, now)).toEqual({ ...second, lastNudgeAt: now })
    expect(recordEngaged(second, now)).toEqual({ ...second, lastEngagedAt: now })
  })

  it('picks the moment at random between the minimum and the maximum session time', () => {
    expect(nudgeDelay(0)).toBe(NUDGE_RULES.minSessionMs)
    expect(nudgeDelay(0.5)).toBe((NUDGE_RULES.minSessionMs + NUDGE_RULES.maxSessionMs) / 2)
    expect(nudgeDelay(0.999999)).toBeLessThanOrEqual(NUDGE_RULES.maxSessionMs)
    expect(nudgeDelay(-1)).toBe(NUDGE_RULES.minSessionMs)
    expect(nudgeDelay(2)).toBe(NUDGE_RULES.maxSessionMs)
  })

  it('reads stored state and treats anything unreadable as a fresh install', () => {
    const state = settled({ lastNudgeAt: now, lastEngagedAt: now - DAY })
    expect(parseNudgeState(JSON.stringify(state))).toEqual(state)
    expect(parseNudgeState(JSON.stringify({ firstSeenAt: T0, launches: 2 }))).toEqual({ firstSeenAt: T0, launches: 2, lastNudgeAt: null, lastEngagedAt: null })
    expect(parseNudgeState(JSON.stringify({ ...state, lastNudgeAt: 'yesterday' }))).toEqual({ ...state, lastNudgeAt: null })
    for (const raw of [null, '', 'not json', '[]', '42', '{}', JSON.stringify({ firstSeenAt: -1, launches: 2 }), JSON.stringify({ firstSeenAt: T0 })]) {
      expect(parseNudgeState(raw)).toBeNull()
    }
  })
})
