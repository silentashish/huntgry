import type { ReactNode } from 'react'
import classes from './ui.module.css'

export interface MonoLabelProps {
  children: ReactNode
  /** `xs` 10 px (mono/xs: eyebrows, captions), `sm` 11 px (mono/sm: labels, readouts). Default `sm`. */
  size?: 'xs' | 'sm'
  /** Default `muted`. */
  tone?: 'muted' | 'secondary' | 'primary' | 'accent' | 'inherit'
  component?: 'span' | 'div' | 'p'
  className?: string
  title?: string
}

/** Geist Mono readout: costs, tokens, times, paths and the small spaced-out labels above values. */
export function MonoLabel({ children, size = 'sm', tone = 'muted', component: Component = 'span', className, title }: MonoLabelProps) {
  return (
    <Component className={className ? `${classes.mono} ${className}` : classes.mono} data-size={size} data-tone={tone} title={title}>
      {children}
    </Component>
  )
}
