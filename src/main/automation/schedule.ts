import type { AutomationWindow } from '@shared/automation-types'

/**
 * The run window (#154), in local time: `22:00`–`07:00` crosses midnight. Pure; the service's tick asks it
 * whether a run may start and when the window opens next.
 */

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Whether `now` falls inside the window (start included, end excluded). */
export function isOpen(window: AutomationWindow, now: Date): boolean {
  if (window.mode === 'anytime') return true
  const t = now.getHours() * 60 + now.getMinutes()
  const start = minutesOf(window.start)
  const end = minutesOf(window.end)
  return start < end ? t >= start && t < end : t >= start || t < end
}

/** When the window opens next after `now`, or `null` when it is open now (or always open). */
export function nextOpen(window: AutomationWindow, now: Date): Date | null {
  if (window.mode === 'anytime' || isOpen(window, now)) return null
  const start = minutesOf(window.start)
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(start / 60), start % 60, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/** When the open window closes next, or `null` when it is closed now or always open. */
export function nextClose(window: AutomationWindow, now: Date): Date | null {
  if (window.mode === 'anytime' || !isOpen(window, now)) return null
  const end = minutesOf(window.end)
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(end / 60), end % 60, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}
