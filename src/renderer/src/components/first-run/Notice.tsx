import type { ReactNode } from 'react'
import { IconAlertTriangle, IconCircleCheck, IconCircleX } from '@tabler/icons-react'
import { toneStyle } from '../ui'
import classes from './first-run.module.css'

export type NoticeTone = 'success' | 'warning' | 'danger'

const ICONS: Record<NoticeTone, ReactNode> = {
  success: <IconCircleCheck size={16} />,
  warning: <IconAlertTriangle size={16} />,
  danger: <IconCircleX size={16} />
}

interface Props {
  tone: NoticeTone
  children: ReactNode
  /** Buttons under the text, e.g. "Create workspace here". */
  actions?: ReactNode
  /** `status` for results and problems (e2e and screen readers find them); none for static info. */
  role?: 'status'
}

/** Soft tone banner of the first-run screens (Figma 15:105). */
export function Notice({ tone, children, actions, role }: Props) {
  return (
    <div className={classes.notice} style={toneStyle(tone)} role={role} data-tone={tone}>
      <span className={classes.noticeIcon} aria-hidden>
        {ICONS[tone]}
      </span>
      <div className={classes.noticeBody}>
        <div className={classes.noticeLine}>{children}</div>
        {actions}
      </div>
    </div>
  )
}
