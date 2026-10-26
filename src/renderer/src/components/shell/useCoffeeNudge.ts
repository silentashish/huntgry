import { useCallback, useEffect, useRef, useState } from 'react'
import {
  NUDGE_FORCE_KEY,
  NUDGE_RULES,
  NUDGE_STORAGE_KEY,
  nudgeDelay,
  parseNudgeState,
  recordEngaged,
  recordLaunch,
  recordNudge,
  shouldNudge,
  type NudgeState
} from './coffee'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function read(): NudgeState | null {
  try {
    return parseNudgeState(storage()?.getItem(NUDGE_STORAGE_KEY) ?? null)
  } catch {
    return null
  }
}

function write(state: NudgeState): void {
  try {
    storage()?.setItem(NUDGE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage full or unavailable: the nudge just follows the in-memory schedule until the app restarts.
  }
}

function forced(): boolean {
  try {
    return storage()?.getItem(NUDGE_FORCE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * When this renderer started and the schedule state as of now. One launch is counted per load, even if the sidebar
 * mounts again (workspace switch, StrictMode). The in-memory state is the one that counts: storage is only where it
 * is saved for the next launch, so a failed write never undoes a nudge or a click within this session.
 */
let session: { startedAt: number; state: NudgeState } | null = null

function startSession(): { startedAt: number; state: NudgeState } {
  if (!session) {
    const startedAt = Date.now()
    const state = recordLaunch(read(), startedAt)
    write(state)
    session = { startedAt, state }
  }
  return session
}

/** Applies `change` to the session's state and saves the result. */
function update(change: (state: NudgeState) => NudgeState): NudgeState {
  const current = startSession()
  current.state = change(current.state)
  write(current.state)
  return current.state
}

export interface CoffeeNudge {
  /** The nudge is playing: the cup wiggles and the bubble shows. */
  nudging: boolean
  /** The bubble is fading out. */
  leaving: boolean
  /** The link was clicked or the bubble closed: hide it and back off for `engagedCooldownMs`. */
  engage(): void
  /** The pointer or focus is on the item or its bubble: keep the bubble up until it leaves. */
  hold(held: boolean): void
}

const FADE_MS = 400

/** Plays the coffee nudge once in a while (see `shouldNudge`), at a random moment into the session. */
export function useCoffeeNudge(): CoffeeNudge {
  const [nudging, setNudging] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const held = useRef(false)
  const expired = useRef(false)
  const timers = useRef<number[]>([])

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const fadeOut = useCallback(() => {
    setLeaving(true)
    later(() => {
      setNudging(false)
      setLeaving(false)
    }, FADE_MS)
  }, [later])

  useEffect(() => {
    const { startedAt } = startSession()
    const force = forced()
    let onVisible: (() => void) | null = null

    const play = (): void => {
      const now = Date.now()
      if (!force && !shouldNudge(startSession().state, now, startedAt)) return
      update((state) => recordNudge(state, now))
      expired.current = false
      setLeaving(false)
      setNudging(true)
      later(() => {
        expired.current = true
        if (!held.current) fadeOut()
      }, NUDGE_RULES.bubbleMs)
    }

    // A window in the background would play it to nobody: wait until it is in front again.
    const attempt = (): void => {
      if (document.visibilityState !== 'hidden') return play()
      onVisible = () => {
        if (document.visibilityState === 'hidden') return
        document.removeEventListener('visibilitychange', onVisible!)
        onVisible = null
        play()
      }
      document.addEventListener('visibilitychange', onVisible)
    }

    // Forced: a moment after launch. Otherwise at a random time into the session, where the rule decides.
    later(attempt, force ? 1_500 : Math.max(0, startedAt + nudgeDelay(Math.random()) - Date.now()))

    return () => {
      for (const t of timers.current) window.clearTimeout(t)
      timers.current = []
      if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    }
  }, [later, fadeOut])

  const engage = useCallback(() => {
    update((state) => recordEngaged(state, Date.now()))
    setNudging(false)
    setLeaving(false)
  }, [])

  const hold = useCallback(
    (h: boolean) => {
      held.current = h
      if (!h && expired.current) {
        expired.current = false
        fadeOut()
      }
    },
    [fadeOut]
  )

  return { nudging, leaving, engage, hold }
}

/** Test hook: forget the counted launch so the next mount starts a new session. */
export function resetCoffeeSession(): void {
  session = null
}
