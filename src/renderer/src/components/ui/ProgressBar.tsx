import { toneStyle, type UiTone } from './tones'
import classes from './ui.module.css'

export interface ProgressBarProps {
  /** 0–100. */
  value: number
  /** Default `accent` (Ember); `trail` for the running pipeline, `success` for evidence strength. */
  tone?: UiTone
  /** 4 px, 6 px (default) or 8 px. */
  size?: 'xs' | 'sm' | 'md'
  /** Accessible name, e.g. "5 of 20 jobs". */
  'aria-label'?: string
  className?: string
}

/** Thin progress track (Figma Data display → progress, progress-trail). */
export function ProgressBar({ value, tone = 'accent', size = 'sm', className, ...rest }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div
      className={className ? `${classes.progress} ${className}` : classes.progress}
      data-size={size}
      style={toneStyle(tone)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={rest['aria-label']}
    >
      <div className={classes.progressBar} style={{ width: `${pct}%` }} />
    </div>
  )
}
