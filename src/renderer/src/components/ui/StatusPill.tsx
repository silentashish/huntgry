import type { ReactNode } from 'react'
import { toneStyle, type UiTone } from './tones'
import classes from './ui.module.css'

export interface StatusPillProps {
  children: ReactNode
  /** Default `neutral`. */
  tone?: UiTone
  /** `soft` tinted background (default), `outline` tone border, `solid` filled. */
  variant?: 'soft' | 'outline' | 'solid'
  /** A leading 6 px dot in the tone colour (live states: Running, Working, Waiting for you). */
  dot?: boolean
  /** Icon before the label (12–14 px). */
  leftSection?: ReactNode
  /** `sm` 18 px / 11 px (default, Figma Badge), `md` 22 px / 12 px. */
  size?: 'sm' | 'md'
  title?: string
  className?: string
}

/** A status chip (Figma Badge: Tone × Style). */
export function StatusPill({ children, tone = 'neutral', variant = 'soft', dot, leftSection, size = 'sm', title, className }: StatusPillProps) {
  return (
    <span
      className={className ? `${classes.pill} ${className}` : classes.pill}
      style={toneStyle(tone)}
      data-tone={tone}
      data-variant={variant}
      data-size={size}
      title={title}
    >
      {dot && <span className={classes.pillDot} aria-hidden />}
      {leftSection != null && <span className={classes.pillSection}>{leftSection}</span>}
      <span className={classes.pillLabel}>{children}</span>
    </span>
  )
}
