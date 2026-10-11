import type { ReactNode } from 'react'
import { toneStyle, type UiTone } from './tones'
import classes from './ui.module.css'

export interface EmptyStateProps {
  /** Icon in the disc (about 28 px; 22 px when `compact`). */
  icon?: ReactNode
  /** Disc colour; `accent` adds the ember glow. Default `accent`. */
  tone?: UiTone
  title: ReactNode
  /** Heading level; default 3. */
  titleOrder?: 2 | 3 | 4
  description?: ReactNode
  /** Buttons: one `variant="primary"`, then `variant="default"`. */
  actions?: ReactNode
  /** Small muted line under the actions, e.g. keyboard hints with <Kbd>. */
  hint?: ReactNode
  /** Smaller, for empty cards and panels instead of whole pages. */
  compact?: boolean
  className?: string
}

/** An empty page or panel (Figma Browser — Empty, Review — Empty, Dashboard — Empty). */
export function EmptyState({ icon, tone = 'accent', title, titleOrder = 3, description, actions, hint, compact, className }: EmptyStateProps) {
  const Heading = titleOrder === 2 ? 'h2' : titleOrder === 4 ? 'h4' : 'h3'
  return (
    <div className={className ? `${classes.empty} ${className}` : classes.empty} data-compact={compact || undefined}>
      {icon != null && (
        <span className={classes.emptyIcon} style={toneStyle(tone)} data-tone={tone} aria-hidden>
          {icon}
        </span>
      )}
      <Heading className={classes.emptyTitle}>{title}</Heading>
      {description != null && <p className={classes.emptyDescription}>{description}</p>}
      {actions != null && <div className={classes.emptyActions}>{actions}</div>}
      {hint != null && <div className={classes.emptyHint}>{hint}</div>}
    </div>
  )
}
