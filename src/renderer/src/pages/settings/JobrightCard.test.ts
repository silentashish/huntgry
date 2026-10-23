// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { checkedLabel } from './JobrightCard'

describe('checkedLabel (#146)', () => {
  const now = Date.parse('2026-10-22T12:00:00.000Z')
  it('says when the Jobright sign-in was last seen', () => {
    expect(checkedLabel(null, now)).toBe('Not checked yet')
    expect(checkedLabel('not a date', now)).toBe('Not checked yet')
    expect(checkedLabel('2026-10-22T11:59:45.000Z', now)).toBe('Checked just now')
    expect(checkedLabel('2026-10-22T11:35:00.000Z', now)).toBe('Checked 25 min ago')
    expect(checkedLabel('2026-10-22T07:00:00.000Z', now)).toBe('Checked 5 h ago')
    expect(checkedLabel('2026-10-19T12:00:00.000Z', now)).toBe('Checked 3 days ago')
  })
})
