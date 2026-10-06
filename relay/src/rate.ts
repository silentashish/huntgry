/**
 * The per-connection frame budget (ADR "Relay authentication and isolation": 60 frames a
 * minute). The window lives in the socket's serialised attachment, not in the Durable Object's
 * memory, because hibernation discards that memory while the connection stays open.
 */
export interface RateWindow {
  /** Start of the current one-minute window (ms). */
  start: number
  /** Frames counted in it, this one included. */
  count: number
}

export const RATE_WINDOW_MS = 60_000

/** Counts one frame at `now`; `ok` is false once the window holds more than `limit`. */
export function countFrame(window: RateWindow | undefined, now: number, limit: number): { window: RateWindow; ok: boolean } {
  const next = !window || now - window.start >= RATE_WINDOW_MS ? { start: now, count: 1 } : { start: window.start, count: window.count + 1 }
  return { window: next, ok: next.count <= limit }
}
