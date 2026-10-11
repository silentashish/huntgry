import type { ReactNode } from 'react'
import { PawLogo } from '../ui'
import classes from './first-run.module.css'

interface Props {
  /** One line under the wordmark. */
  subtitle?: ReactNode
  /** `picker` 620 px column, `setup` 720 px. */
  width?: 'picker' | 'setup'
  children?: ReactNode
}

/** First-run page (Figma 15:2 / 15:92): scent glows, the paw and "Huntgry" (h2), then the step. */
export function FirstRunLayout({ subtitle, width = 'picker', children }: Props) {
  return (
    <main className={classes.page}>
      <header className={classes.header}>
        <PawLogo size={56} />
        <h2 className={classes.title}>Huntgry</h2>
        {subtitle && <p className={classes.subtitle}>{subtitle}</p>}
      </header>
      <div className={classes.body} data-width={width}>
        {children}
      </div>
    </main>
  )
}
