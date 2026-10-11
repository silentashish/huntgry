import type { ReactNode } from 'react'
import { IconCheck } from '@tabler/icons-react'
import { MonoLabel } from './MonoLabel'
import { toneStyle, type UiTone } from './tones'
import classes from './ui.module.css'

/** Strong scent (≥ 80) is Ember, a fair one (≥ 60) warning yellow, the rest neutral. */
export function scoreTone(value: number): UiTone {
  if (value >= 80) return 'accent'
  if (value >= 60) return 'warning'
  return 'neutral'
}

/** "Strong scent" / "Fair scent" / "Faint scent", for drawers and tooltips. */
export function scoreLabel(value: number): string {
  if (value >= 80) return 'Strong scent'
  if (value >= 60) return 'Fair scent'
  return 'Faint scent'
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

export interface ScoreRingProps {
  /**
   * `score`: the Scent score 0–100 inside the ring (default). `done`: a check in a success ring
   * (already tailored / applied). `initial`: a letter in a neutral ring (no score yet).
   */
  mode?: 'score' | 'done' | 'initial'
  /** The score, 0–100 (score mode). */
  value?: number
  /** One or two characters (initial mode); defaults to "?". */
  letter?: string
  /** 32 px, 44 px (default, Jobs list) or 56 px (job drawer). */
  size?: 'sm' | 'md' | 'lg'
  /** Override the colour picked from the score. */
  tone?: UiTone
  /** Mono caption under the ring, e.g. "scent". */
  caption?: ReactNode
  /** Accessible name; defaults to "Scent 92 of 100", "Done" or the letter. */
  'aria-label'?: string
  className?: string
}

/** The Scent score ring of Jobs, the job drawer and the Board (Figma Jobs — Relevant). */
export function ScoreRing({ mode = 'score', value = 0, letter, size = 'md', tone, caption, className, ...rest }: ScoreRingProps) {
  const score = clamp(value)
  const resolved: UiTone = tone ?? (mode === 'done' ? 'success' : mode === 'initial' ? 'neutral' : scoreTone(score))
  const label = rest['aria-label'] ?? (mode === 'done' ? 'Done' : mode === 'initial' ? (letter ?? '?') : `Scent ${score} of 100`)
  const iconSize = size === 'lg' ? 24 : size === 'md' ? 18 : 14
  const content = mode === 'done' ? <IconCheck size={iconSize} stroke={2.5} aria-hidden /> : mode === 'initial' ? Array.from(letter ?? '?').slice(0, 2).join('') : score
  return (
    <span className={className ? `${classes.scoreRing} ${className}` : classes.scoreRing}>
      <span className={classes.ring} style={toneStyle(resolved)} data-tone={resolved} data-size={size} data-mode={mode} role="img" aria-label={label}>
        <span aria-hidden>{content}</span>
      </span>
      {caption != null && <MonoLabel size="xs">{caption}</MonoLabel>}
    </span>
  )
}
