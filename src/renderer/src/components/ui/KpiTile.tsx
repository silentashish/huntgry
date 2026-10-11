import type { ReactNode } from 'react'
import { MonoLabel } from './MonoLabel'
import classes from './ui.module.css'

export interface KpiTileProps {
  /** Mono label above the value ("Total", "Est. API cost"). */
  label: ReactNode
  /** The figure, in the display face (`md`) or Geist semibold (`sm`). */
  value: ReactNode
  /** One muted line under the value ("resumes built", "$0.37/run"). */
  sub?: ReactNode
  /** Ember border: the tile is the active filter. */
  selected?: boolean
  /** Value in Ember text (the "Scent" tile). */
  accent?: boolean
  /** `md`: the Dashboard stat tiles (default). `sm`: compact sunken tiles (run metrics, job facts). */
  size?: 'sm' | 'md'
  /** Makes the tile a toggle button (`aria-pressed` = `selected`). */
  onClick?: () => void
  'aria-label'?: string
  className?: string
}

/** A KPI / stat tile (Figma Data display → kpi, kpi-accent; Dashboard stat tiles). */
export function KpiTile({ label, value, sub, selected, accent, size = 'md', onClick, className, ...rest }: KpiTileProps) {
  const body = (
    <>
      <MonoLabel size={size === 'sm' ? 'xs' : 'sm'}>{label}</MonoLabel>
      <span className={classes.kpiValue}>{value}</span>
      {(sub != null || size === 'md') && <span className={classes.kpiSub}>{sub}</span>}
    </>
  )
  const common = {
    className: className ? `${classes.kpi} ${className}` : classes.kpi,
    'data-size': size,
    'data-selected': selected || undefined,
    'data-accent': accent || undefined,
    'aria-label': rest['aria-label']
  }
  if (onClick) {
    return (
      <button type="button" {...common} aria-pressed={!!selected} onClick={onClick}>
        {body}
      </button>
    )
  }
  return <div {...common}>{body}</div>
}
