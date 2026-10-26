/**
 * The sidebar's "Buy me a coffee" link and when its nudge plays (#185). Huntgry is free; the link is the
 * one place in the app that says so. The nudge (cup wiggle, steam, an "Enjoying Huntgry?" bubble) is
 * rare on purpose: never in the first sessions, never at startup, at most once a week, and quiet for two
 * months once the user has clicked the link or closed the bubble. The schedule state is kept in
 * localStorage like the colour scheme and the Board's folds, so it survives a restart.
 */

export const COFFEE_URL = 'https://buymeacoffee.com/silentashish'

export const NUDGE_STORAGE_KEY = 'huntgry-coffee-nudge'
/** Set to `1` to play the nudge a moment after launch whatever the schedule says (screenshots, manual checks). */
export const NUDGE_FORCE_KEY = 'huntgry-coffee-nudge-force'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const NUDGE_RULES = {
  /** Not before the third launch: the first sessions are for getting set up. */
  minLaunches: 3,
  /** Not before the app has been installed (first seen) for this long. */
  minAgeMs: 3 * DAY,
  /** Not before the app has been open this long in the current session… */
  minSessionMs: 10 * MINUTE,
  /** …and the moment is picked at random up to this long into the session, so it never lines up with launch. */
  maxSessionMs: 40 * MINUTE,
  /** At most one nudge per this long. */
  cooldownMs: 7 * DAY,
  /** After a click on the link or a dismissed bubble. */
  engagedCooldownMs: 60 * DAY,
  /** The bubble fades out on its own after this long. */
  bubbleMs: 9_000
} as const

export interface NudgeState {
  /** First launch seen (ms). */
  firstSeenAt: number
  launches: number
  /** Last time the nudge played (ms). */
  lastNudgeAt: number | null
  /** Last click on the link or dismissal of the bubble (ms). */
  lastEngagedAt: number | null
}

const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** The stored state, or `null` when there is none or it is unreadable (a fresh install as far as the nudge goes). */
export function parseNudgeState(raw: string | null): NudgeState | null {
  try {
    const v = JSON.parse(raw ?? 'null') as Record<string, unknown> | null
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const firstSeenAt = time(v.firstSeenAt)
    const launches = time(v.launches)
    if (firstSeenAt === null || launches === null) return null
    return { firstSeenAt, launches: Math.floor(launches), lastNudgeAt: time(v.lastNudgeAt), lastEngagedAt: time(v.lastEngagedAt) }
  } catch {
    return null
  }
}

/** One more launch; the first one starts the clock. */
export function recordLaunch(state: NudgeState | null, now: number): NudgeState {
  if (!state) return { firstSeenAt: now, launches: 1, lastNudgeAt: null, lastEngagedAt: null }
  return { ...state, launches: state.launches + 1 }
}

export function recordNudge(state: NudgeState, now: number): NudgeState {
  return { ...state, lastNudgeAt: now }
}

/** The user clicked the link or closed the bubble: back off for much longer. */
export function recordEngaged(state: NudgeState, now: number): NudgeState {
  return { ...state, lastEngagedAt: now }
}

/** Whether the nudge may play `now`, in a session that started at `sessionStartedAt`. */
export function shouldNudge(state: NudgeState, now: number, sessionStartedAt: number): boolean {
  if (state.launches < NUDGE_RULES.minLaunches) return false
  if (now - state.firstSeenAt < NUDGE_RULES.minAgeMs) return false
  if (now - sessionStartedAt < NUDGE_RULES.minSessionMs) return false
  if (state.lastNudgeAt !== null && now - state.lastNudgeAt < NUDGE_RULES.cooldownMs) return false
  if (state.lastEngagedAt !== null && now - state.lastEngagedAt < NUDGE_RULES.engagedCooldownMs) return false
  return true
}

/** How long into the session to try the nudge, from `random` in [0, 1): between `minSessionMs` and `maxSessionMs`. */
export function nudgeDelay(random: number): number {
  const r = Math.min(Math.max(random, 0), 1)
  return Math.round(NUDGE_RULES.minSessionMs + r * (NUDGE_RULES.maxSessionMs - NUDGE_RULES.minSessionMs))
}
