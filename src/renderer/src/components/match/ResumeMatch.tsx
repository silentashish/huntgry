import type { ApplicationMatch } from '@shared/applications-types'
import { MonoLabel, StatusPill } from '../ui'
import { matchText } from './match-text'
import classes from './match.module.css'

interface Props {
  match: ApplicationMatch | undefined
  /** One mono line for a Board card (what was left out is in its hover text); else the line, the left-out skills and the skill's hint. */
  compact?: boolean
  className?: string
}

/**
 * Profile fit vs resume coverage after tailoring (#151): "Profile fit 82 · Resume 74 (90% surfaced)", the
 * requirements the profile has that the resume left out (what a re-run could add) and the skill's own
 * keyword check's "Absent" terms. Nothing when the application was never scored.
 */
export function ResumeMatch({ match, compact = false, className }: Props) {
  if (!match) return null
  const { line, title, leftOut } = matchText(match)
  if (compact) {
    return (
      <MonoLabel size="xs" component="div" className={className} title={leftOut ? `${title}\n${leftOut}` : title}>
        {line}
      </MonoLabel>
    )
  }
  return (
    <div className={className ? `${classes.match} ${className}` : classes.match} data-testid="resume-match">
      <MonoLabel component="div" tone="secondary" title={title}>
        {line}
      </MonoLabel>
      {match.gates?.map((g) => (
        <div key={g} className={classes.note}>
          {g}
        </div>
      ))}
      {match.leftOut.length > 0 && (
        <div className={classes.row} aria-label="Left out of the resume">
          <MonoLabel size="xs">In your profile, not on the resume</MonoLabel>
          {match.leftOut.map((s) => (
            <StatusPill key={s} tone="warning" variant="outline">
              {s}
            </StatusPill>
          ))}
        </div>
      )}
      {match.absent && match.absent.length > 0 && (
        <div className={classes.note} title="The resume-tailor skill's own keyword check (build-report.json → jd_keyword_coverage)">
          Absent (skill's keyword check): {match.absent.join(', ')}
        </div>
      )}
    </div>
  )
}
