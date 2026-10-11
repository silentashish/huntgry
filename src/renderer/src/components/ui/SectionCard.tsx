import type { ReactNode } from 'react'
import { Card, type MantineSpacing } from '@mantine/core'
import classes from './ui.module.css'

export interface SectionCardProps {
  /** Card title (Geist semibold 16 px). Omit for a plain surface card. */
  title?: ReactNode
  /** Heading level of the title; default 3. */
  titleOrder?: 3 | 4
  /** 16–18 px icon before the title. */
  icon?: ReactNode
  /** Pills or counts right after the title ("Finished", "3 working"). */
  badge?: ReactNode
  /** One line under the title, in secondary text. */
  description?: ReactNode
  /** Buttons or links on the right of the header. */
  actions?: ReactNode
  /** Coloured border: `ember` (selected / the one to act on) or `trail` (running pipeline). */
  accent?: 'ember' | 'trail'
  /** Inner padding; default `lg` (24 px). */
  padding?: MantineSpacing
  children?: ReactNode
  className?: string
  'aria-label'?: string
}

/**
 * A surface card with an optional header (icon, title, badges, actions). Renders Mantine's Card,
 * so `.mantine-Card-root` locators keep working.
 */
export function SectionCard({ title, titleOrder = 3, icon, badge, description, actions, accent, padding = 'lg', children, className, ...rest }: SectionCardProps) {
  const Heading = titleOrder === 4 ? 'h4' : 'h3'
  const hasHeader = title != null || actions != null || badge != null
  return (
    <Card withBorder padding={padding} radius="xl" className={className ? `${classes.card} ${className}` : classes.card} data-accent={accent} aria-label={rest['aria-label']}>
      {hasHeader && (
        <div>
          <div className={classes.cardHeader}>
            {icon != null && <span className={classes.cardIcon}>{icon}</span>}
            <div className={classes.cardTitleWrap}>
              {title != null && <Heading className={classes.cardTitle}>{title}</Heading>}
              {badge}
            </div>
            {actions != null && <div className={classes.cardActions}>{actions}</div>}
          </div>
          {description != null && <p className={classes.cardDescription}>{description}</p>}
        </div>
      )}
      {children != null && <div className={hasHeader ? classes.cardBody : undefined}>{children}</div>}
    </Card>
  )
}
