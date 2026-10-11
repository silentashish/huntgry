import type { CSSProperties } from 'react'

/**
 * Status tones of the shared parts. `accent` is Ember (the hunt accent), `trail` the teal
 * "already found" colour; the rest map 1:1 to the --hg-status-* tokens.
 */
export type UiTone = 'neutral' | 'accent' | 'trail' | 'success' | 'warning' | 'danger' | 'info' | 'review'

export const UI_TONES: readonly UiTone[] = ['neutral', 'accent', 'trail', 'success', 'warning', 'danger', 'info', 'review']

interface ToneVars {
  /** Text, dot and outline colour. */
  fg: string
  /** Soft background. */
  soft: string
  /** Solid fill. */
  solid: string
  /** Text on the solid fill. */
  onSolid: string
}

export const TONE_VARS: Record<UiTone, ToneVars> = {
  neutral: { fg: 'var(--hg-text-secondary)', soft: 'var(--hg-bg-subtle)', solid: 'var(--hg-text-muted)', onSolid: 'var(--hg-bg-surface)' },
  accent: { fg: 'var(--hg-text-accent)', soft: 'var(--hg-accent-primary-soft)', solid: 'var(--hg-accent-primary)', onSolid: 'var(--hg-text-on-accent)' },
  trail: { fg: 'var(--hg-accent-secondary)', soft: 'var(--hg-accent-secondary-soft)', solid: 'var(--hg-accent-secondary)', onSolid: 'var(--hg-text-on-accent)' },
  success: { fg: 'var(--hg-status-success)', soft: 'var(--hg-status-success-soft)', solid: 'var(--hg-status-success)', onSolid: 'var(--hg-text-on-accent)' },
  warning: { fg: 'var(--hg-status-warning)', soft: 'var(--hg-status-warning-soft)', solid: 'var(--hg-status-warning)', onSolid: 'var(--hg-text-on-accent)' },
  danger: { fg: 'var(--hg-status-danger)', soft: 'var(--hg-status-danger-soft)', solid: 'var(--hg-status-danger)', onSolid: 'var(--hg-white)' },
  info: { fg: 'var(--hg-status-info)', soft: 'var(--hg-status-info-soft)', solid: 'var(--hg-status-info)', onSolid: 'var(--hg-white)' },
  review: { fg: 'var(--hg-status-review)', soft: 'var(--hg-status-review-soft)', solid: 'var(--hg-status-review)', onSolid: 'var(--hg-white)' }
}

/** The tone as CSS custom properties (--tone-fg, --tone-soft, --tone-solid, --tone-on-solid) for a part's stylesheet. */
export function toneStyle(tone: UiTone, style?: CSSProperties): CSSProperties {
  const v = TONE_VARS[tone]
  return { '--tone-fg': v.fg, '--tone-soft': v.soft, '--tone-solid': v.solid, '--tone-on-solid': v.onSolid, ...style } as CSSProperties
}
