import { Tooltip } from '@mantine/core'
import type { ApplicationRecord } from '@shared/applications-types'
import { StatusPill, type UiTone } from '../../components/ui'

/** Label, tone and detail of the skill's `build-report.json` result. Pure, for the badge and tests. */
export function buildBadgeOf(build: ApplicationRecord['build'], short: boolean): { tone: UiTone; label: string; detail: string } {
  const warnings = build.warnings > 0 ? `${build.warnings} warning${build.warnings === 1 ? '' : 's'}` : ''
  if (build.status === 'unknown') {
    return { tone: 'neutral', label: short ? 'No report' : 'No build report', detail: 'build-report.json is missing or unreadable' }
  }
  if (build.status === 'pass') {
    return {
      tone: 'success',
      label: short ? `ATS passed${warnings ? ` · ${warnings}` : ''}` : `ATS checks passed${warnings ? ` · ${warnings}` : ''}`,
      detail: warnings || 'All checks passed'
    }
  }
  return {
    tone: 'danger',
    label: short ? 'Build failed' : `Build failed${build.failed.length ? `: ${build.failed.join(', ')}` : ''}`,
    detail: build.failed.join(', ') || 'The build did not pass'
  }
}

/** Build result of the skill's `build-report.json`; `short` for table cells, details in the tooltip. */
export function BuildBadge({ app, short = false }: { app: ApplicationRecord; short?: boolean }) {
  const { tone, label, detail } = buildBadgeOf(app.build, short)
  const pill = (
    <StatusPill tone={tone} size={short ? 'sm' : 'md'}>
      {label}
    </StatusPill>
  )
  return short ? (
    <Tooltip label={detail} withArrow>
      <span style={{ display: 'inline-flex' }}>{pill}</span>
    </Tooltip>
  ) : (
    pill
  )
}
