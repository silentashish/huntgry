import { MAX_URL_LENGTH, type BrowserRect } from '@shared/browser-types'

/** Input checks for the browser IPC handlers (pure, so unit-tested). */

export function requireTabId(id: unknown): string {
  if (typeof id !== 'string' || !/^tab-\d{1,6}$/.test(id)) throw new Error('Invalid tab id.')
  return id
}

export function requireText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) throw new Error('Enter a URL.')
  return value
}

/** A rectangle of finite, non-negative CSS pixels, rounded to whole pixels. */
export function requireRect(value: unknown): BrowserRect {
  const r = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const n = (v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw new Error('Invalid bounds.')
    return Math.round(v)
  }
  return { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) }
}
