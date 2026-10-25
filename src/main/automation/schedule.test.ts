import { describe, expect, it } from 'vitest'
import { isOpen, nextClose, nextOpen } from './schedule'

/** Local times (the window is local), on 24 Oct 2026. */
const at = (h: number, m = 0, day = 24) => new Date(2026, 9, day, h, m)
const overnight = { mode: 'window' as const, start: '22:00', end: '07:00' }
const daytime = { mode: 'window' as const, start: '09:30', end: '17:00' }

describe('run window', () => {
  it('a window crossing midnight is open from its start to its end, start included and end excluded', () => {
    expect(isOpen(overnight, at(21, 59))).toBe(false)
    expect(isOpen(overnight, at(22, 0))).toBe(true)
    expect(isOpen(overnight, at(23, 30))).toBe(true)
    expect(isOpen(overnight, at(0, 0))).toBe(true)
    expect(isOpen(overnight, at(6, 59))).toBe(true)
    expect(isOpen(overnight, at(7, 0))).toBe(false)
    expect(isOpen(overnight, at(12, 0))).toBe(false)
  })

  it('a daytime window is open between its times only', () => {
    expect(isOpen(daytime, at(9, 29))).toBe(false)
    expect(isOpen(daytime, at(9, 30))).toBe(true)
    expect(isOpen(daytime, at(16, 59))).toBe(true)
    expect(isOpen(daytime, at(17, 0))).toBe(false)
  })

  it('anytime is always open', () => {
    expect(isOpen({ mode: 'anytime' }, at(3))).toBe(true)
    expect(nextOpen({ mode: 'anytime' }, at(3))).toBeNull()
    expect(nextClose({ mode: 'anytime' }, at(3))).toBeNull()
  })

  it('nextOpen: later today, or tomorrow once today’s start has passed; null while open', () => {
    expect(nextOpen(overnight, at(12, 0))).toEqual(at(22, 0))
    expect(nextOpen(overnight, at(23, 0))).toBeNull()
    expect(nextOpen(daytime, at(18, 0))).toEqual(at(9, 30, 25))
    expect(nextOpen(daytime, at(8, 0))).toEqual(at(9, 30))
  })

  it('nextClose: the coming end time while open, across midnight', () => {
    expect(nextClose(overnight, at(23, 0))).toEqual(at(7, 0, 25))
    expect(nextClose(overnight, at(2, 0))).toEqual(at(7, 0))
    expect(nextClose(overnight, at(12, 0))).toBeNull()
  })
})
