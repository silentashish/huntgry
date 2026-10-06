import { describe, expect, it } from 'vitest'
import { RATE_WINDOW_MS, countFrame, type RateWindow } from '../src/rate'

/** The per-connection budget is plain data, so it survives being serialised with the socket. */
describe('countFrame', () => {
  it('allows `limit` frames in a window and refuses the next', () => {
    let w: RateWindow | undefined
    for (let i = 0; i < 60; i++) {
      const r = countFrame(w, 1_000 + i, 60)
      expect(r.ok).toBe(true)
      w = r.window
    }
    expect(countFrame(w, 2_000, 60).ok).toBe(false)
  })

  it('keeps counting from a window restored from JSON, as after hibernation', () => {
    let w: RateWindow | undefined
    for (let i = 0; i < 55; i++) w = countFrame(w, 1_000, 60).window
    const restored = JSON.parse(JSON.stringify(w)) as RateWindow // serializeAttachment round trip
    let r = { window: restored, ok: true }
    for (let i = 0; i < 5; i++) r = countFrame(r.window, 13_000, 60)
    expect(r.ok).toBe(true)
    expect(countFrame(r.window, 13_000, 60).ok).toBe(false)
  })

  it('starts a new window once a minute has passed', () => {
    const full: RateWindow = { start: 0, count: 60 }
    expect(countFrame(full, RATE_WINDOW_MS - 1, 60).ok).toBe(false)
    expect(countFrame(full, RATE_WINDOW_MS, 60)).toEqual({ window: { start: RATE_WINDOW_MS, count: 1 }, ok: true })
  })
})
