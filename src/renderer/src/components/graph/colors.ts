import { useEffect, useState } from 'react'
import type { NodeKind } from '@shared/knowledge-graph'
import type { UiTone } from '../ui'

/**
 * Colour per node kind, as Scent Trail tokens (Figma 🖥 Profile — Knowledge graph legend). The
 * semantic tokens switch with the colour scheme; the two trail primitives keep Company and
 * Project apart in both schemes.
 */
export const KIND_COLOR: Record<NodeKind, string> = {
  person: 'var(--hg-status-info)',
  experience: 'var(--hg-status-review)',
  company: 'var(--hg-trail-600)',
  project: 'var(--hg-trail-400)',
  skill: 'var(--hg-status-success)',
  education: 'var(--hg-text-secondary)',
  certification: 'var(--hg-text-muted)',
  publication: 'var(--hg-ink-300)',
  job: 'var(--hg-status-warning)'
}

/** A skill saved jobs ask for that the profile lacks. */
export const GAP_COLOR = 'var(--hg-accent-primary)'

/** Pill tone per node kind (node panel badges). */
export const KIND_TONE: Record<NodeKind, UiTone> = {
  person: 'info',
  experience: 'review',
  company: 'trail',
  project: 'trail',
  skill: 'success',
  education: 'neutral',
  certification: 'neutral',
  publication: 'neutral',
  job: 'warning'
}

export const KIND_LABEL: Record<NodeKind, string> = {
  person: 'You',
  experience: 'Role',
  company: 'Company',
  project: 'Project',
  skill: 'Skill',
  education: 'Education',
  certification: 'Certification',
  publication: 'Publication',
  job: 'Job'
}

/** `--hg-x` from `var(--hg-x)` (or the name itself). */
export function tokenName(token: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(token.trim())
  return m ? m[1] : token.trim()
}

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * Parses the colour forms the tokens use: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b / a%)` and
 * `rgb[a](r, g, b, a)`. `null` for anything else.
 */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1
    }
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s)
  if (!fn) return null
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p))
  const [r, g, b] = parts.slice(0, 3).map(channel)
  const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a }
}

/** `color` with its alpha multiplied by `alpha`, as `rgba(…)`; unknown colours come back unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color)
  if (!c) return color
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(c.a * alpha * 1000) / 1000})`
}

/**
 * The current value of each token (e.g. `{ skill: 'var(--hg-status-success)' }` → `#3ecf72`), for
 * drawing on a canvas, which cannot read CSS variables. Re-read whenever the colour scheme (an
 * attribute on <html>) changes, so the canvas follows the theme without knowing which one it is.
 */
export function useTokenValues<K extends string>(tokens: Record<K, string>): Record<K, string> {
  const read = () => {
    const style = getComputedStyle(document.documentElement)
    const out = {} as Record<K, string>
    for (const key of Object.keys(tokens) as K[]) out[key] = style.getPropertyValue(tokenName(tokens[key])).trim()
    return out
  }
  const [values, setValues] = useState(read)
  useEffect(() => {
    const update = () =>
      setValues((prev) => {
        const next = read()
        return (Object.keys(next) as K[]).every((k) => next[k] === prev[k]) ? prev : next
      })
    update()
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mantine-color-scheme', 'style', 'class'] })
    return () => mo.disconnect()
    // `tokens` is a module constant at every call site.
  }, [])
  return values
}
