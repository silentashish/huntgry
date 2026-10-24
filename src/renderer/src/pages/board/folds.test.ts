import { describe, expect, it } from 'vitest'
import { FOLDS_STORAGE_KEY, pruneFolds, readFolds, writeFolds } from './folds'

const memory = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

const NOW = Date.parse('2026-10-21T12:00:00Z')
const DAY = 86_400_000

describe('fold storage', () => {
  it('round-trips the choices and ignores what it cannot read', () => {
    const s = memory()
    writeFolds({ 'applied:2026-10-18': { folded: true, at: NOW }, 'rejected:2026-10-11': { folded: false, at: NOW } }, s, NOW)
    expect(readFolds(s, NOW)).toEqual({ 'applied:2026-10-18': { folded: true, at: NOW }, 'rejected:2026-10-11': { folded: false, at: NOW } })
    s.data.set(FOLDS_STORAGE_KEY, '{nope')
    expect(readFolds(s, NOW)).toEqual({})
    s.data.set(FOLDS_STORAGE_KEY, '{"applied:2026-10-18":"yes","ready:2026-10-18":{"folded":true},"offer:2026-10-18":{"folded":false,"at":5}}')
    expect(readFolds(s, NOW)).toEqual({ 'offer:2026-10-18': { folded: false, at: 5 } })
    expect(readFolds(null)).toEqual({})
  })

  it('reads choices saved as a bare boolean as made now', () => {
    const s = memory()
    s.data.set(FOLDS_STORAGE_KEY, '{"applied:2026-10-11":false}')
    expect(readFolds(s, NOW)).toEqual({ 'applied:2026-10-11': { folded: false, at: NOW } })
  })

  it("keeps a choice just made about a week more than a year old, and saves it (Codex review)", () => {
    const s = memory()
    writeFolds({ 'applied:2024-03-03': { folded: false, at: NOW } }, s, NOW)
    expect(readFolds(s, NOW)).toEqual({ 'applied:2024-03-03': { folded: false, at: NOW } })
  })

  it('drops choices not made again for about a year, whatever their week', () => {
    expect(
      pruneFolds({ 'applied:2026-10-18': { folded: false, at: NOW - 401 * DAY }, 'applied:2020-01-05': { folded: false, at: NOW - 3 * DAY } }, NOW)
    ).toEqual({ 'applied:2020-01-05': { folded: false, at: NOW - 3 * DAY } })
  })
})
