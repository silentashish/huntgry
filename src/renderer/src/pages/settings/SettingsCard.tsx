import type { ReactNode } from 'react'
import { SectionCard, type SectionCardProps, type UiTone } from '../../components/ui'
import classes from './settings.module.css'

/** A Settings card: the shared SectionCard with the Figma "Settings" title size (20 px) and padding (20 px). */
export function SettingsCard({ className, ...props }: SectionCardProps) {
  return <SectionCard padding={20} {...props} className={className ? `${classes.card} ${className}` : classes.card} />
}

/** A table in the Settings frame: rounded border, sunken mono header (Figma "Table"). */
export function TableFrame({ children }: { children: ReactNode }) {
  return <div className={classes.tableWrap}>{children}</div>
}

/** Mono path or value readout, truncated from the left so the file name stays visible. */
export function PathText({
  children,
  tone = 'secondary',
  title
}: {
  children: ReactNode
  tone?: 'primary' | 'secondary'
  title?: string
}) {
  return (
    <span
      className={classes.path}
      data-tone={tone}
      title={title}
      style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: 'rtl',
        textAlign: 'left'
      }}
    >
      {/* direction: rtl truncates the start; <bdi> keeps the leading "/" where it belongs. */}
      <bdi>{children}</bdi>
    </span>
  )
}

/** The tone of a status pill for the Mantine colour names the cards used before (#116). */
export function toneOfColor(color: string): UiTone {
  switch (color) {
    case 'green':
      return 'success'
    case 'red':
      return 'danger'
    case 'orange':
    case 'yellow':
      return 'warning'
    case 'blue':
      return 'info'
    case 'grape':
      return 'review'
    case 'teal':
      return 'trail'
    default:
      return 'neutral'
  }
}
