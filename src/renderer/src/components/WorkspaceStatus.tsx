import type { ReactNode } from 'react'
import { IconAlertTriangle, IconCircleX } from '@tabler/icons-react'
import type { WorkspaceInspection, WorkspaceStatus as Status } from '@shared/workspace-types'
import { MonoLabel, StatusPill, toneStyle, type UiTone } from './ui'
import classes from './first-run/first-run.module.css'

const STATUS_META: Record<Status, { tone: UiTone; hint: string }> = {
  valid: { tone: 'success', hint: 'Ready for the resume-tailor skill.' },
  legacy: { tone: 'warning', hint: 'Older Resume Tailor layout. Importable as is.' },
  empty: { tone: 'info', hint: 'Empty folder. Create a new workspace here.' },
  missing: { tone: 'info', hint: 'Folder does not exist yet. Create will make it.' },
  'not-a-workspace': {
    tone: 'accent',
    hint: 'Folder has other content and no master profile. Create can add a workspace here after you confirm.'
  },
  unverified: { tone: 'warning', hint: 'Folder is too large to check. Pick the workspace folder itself.' },
  invalid: { tone: 'danger', hint: 'This path cannot be used.' }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Card with the inspected path, status badge, master profile, application count,
 * warnings and errors (Figma 15:34), plus the Create / Import buttons for this folder.
 */
export function WorkspaceStatus({ inspection, actions }: { inspection: WorkspaceInspection; actions?: ReactNode }) {
  const meta =
    inspection.status === 'legacy' && !inspection.masterProfile
      ? { ...STATUS_META.legacy, hint: 'Application folders but no master profile. Create adds one; Import needs one.' }
      : STATUS_META[inspection.status]
  return (
    <section className={classes.status} aria-live="polite" aria-label="Workspace">
      <div className={classes.statusHead}>
        <h3 className={classes.statusTitle}>Workspace</h3>
        <StatusPill tone={meta.tone} className={classes.statusBadge}>
          {inspection.status}
        </StatusPill>
        <MonoLabel tone="secondary" className={classes.statusPath}>
          {inspection.path}
        </MonoLabel>
      </div>
      <p className={classes.statusHint}>{meta.hint}</p>
      <dl className={classes.facts}>
        <div className={classes.fact}>
          <dt className={classes.factLabel}>Master profile</dt>
          <dd className={classes.factValue}>{inspection.masterProfile ?? 'none'}</dd>
        </div>
        <div className={classes.fact}>
          <dt className={classes.factLabel}>Applications</dt>
          <dd className={classes.factValue}>{plural(inspection.applicationCount, 'folder', 'folders')}</dd>
        </div>
      </dl>
      {(inspection.errors.length > 0 || inspection.warnings.length > 0) && (
        <ul className={classes.issues}>
          {inspection.errors.map((e) => (
            <li key={`e:${e}`} className={classes.issue} style={toneStyle('danger')}>
              <IconCircleX size={14} aria-hidden />
              <span>Problem: {e}</span>
            </li>
          ))}
          {inspection.warnings.map((w) => (
            <li key={`w:${w}`} className={classes.issue} style={toneStyle('warning')}>
              <IconAlertTriangle size={14} aria-hidden />
              <span>Warning: {w}</span>
            </li>
          ))}
        </ul>
      )}
      {actions}
    </section>
  )
}
