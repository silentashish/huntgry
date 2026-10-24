import { describe, expect, it } from 'vitest'
import { FOLDS_STORAGE_KEY, pruneFolds, readFolds, writeFolds } from './folds'

const memory = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe('fold storage', () => {
  it('round-trips the choices and ignores what it cannot read', () => {
    const s = memory()
    writeFolds({ 'applied:2099-10-18': true, 'rejected:2099-10-11': false }, s)
    expect(readFolds(s)).toEqual({ 'applied:2099-10-18': true, 'rejected:2099-10-11': false })
    s.data.set(FOLDS_STORAGE_KEY, '{nope')
    expect(readFolds(s)).toEqual({})
    s.data.set(FOLDS_STORAGE_KEY, '{"applied:2026-10-18":"yes","ready:2026-10-18":true}')
    expect(readFolds(s)).toEqual({ 'ready:2026-10-18': true })
    expect(readFolds(null)).toEqual({})
  })

  it('drops weeks more than about a year old', () => {
    const now = new Date('2026-10-21T12:00:00Z')
    expect(pruneFolds({ 'applied:2026-10-18': false, 'applied:2025-01-05': false, 'applied:undated': true }, now)).toEqual({
      'applied:2026-10-18': false,
      'applied:undated': true
    })
  })
})
