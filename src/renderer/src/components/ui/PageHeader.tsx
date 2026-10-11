import type { ReactNode } from 'react'
import { MonoLabel } from './MonoLabel'
import classes from './ui.module.css'

export interface PageHeaderProps {
  /** The page title, in the display face (Bricolage Grotesque, 32 px). */
  title: ReactNode
  /** Mono line above the title, e.g. "Tuesday · 7 Oct · the hound is awake". */
  eyebrow?: ReactNode
  /** One line under the title, in secondary text. */
  subtitle?: ReactNode
  /** Buttons on the right; at most one `variant="primary"`. */
  actions?: ReactNode
  /** Heading level. Pages keep 2: the shell's e2e checks look for the page's h2. */
  titleOrder?: 1 | 2
  className?: string
}

/** The top of every page: eyebrow, title, subtitle and actions (Figma `PageHeader`). */
export function PageHeader({ title, eyebrow, subtitle, actions, titleOrder = 2, className }: PageHeaderProps) {
  const Heading = titleOrder === 1 ? 'h1' : 'h2'
  return (
    <header className={className ? `${classes.pageHeader} ${className}` : classes.pageHeader}>
      <div className={classes.pageHeaderText}>
        {eyebrow != null && (
          <MonoLabel size="sm" tone="muted" component="div">
            {eyebrow}
          </MonoLabel>
        )}
        <Heading className={classes.pageHeaderTitle}>{title}</Heading>
        {subtitle != null && <p className={classes.pageHeaderSubtitle}>{subtitle}</p>}
      </div>
      {actions != null && <div className={classes.pageHeaderActions}>{actions}</div>}
    </header>
  )
}
