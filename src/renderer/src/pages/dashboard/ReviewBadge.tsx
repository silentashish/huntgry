import { Tooltip } from '@mantine/core'
import type { ApplicationRecord } from '@shared/applications-types'
import { REVIEW_STATE_LABEL } from '@shared/review-types'
import { StatusPill } from '../../components/ui'
import { REVIEW_TONE } from './status'

/** Unreviewed / Needs attention / Approved / Discarded, for unattended results (#31); nothing for other applications. */
export function ReviewBadge({ app, short = false }: { app: Pick<ApplicationRecord, 'tracking'>; short?: boolean }) {
  const review = app.tracking.review
  if (!review) return null
  const meta = REVIEW_STATE_LABEL[review.state]
  const detail =
    review.reason ??
    (review.state === 'approved'
      ? `Approved ${review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : ''}`
      : 'Built unattended; approve it on the Review page before applying.')
  const pill = (
    <StatusPill tone={REVIEW_TONE[review.state]} variant="outline" size={short ? 'sm' : 'md'}>
      {meta.label}
    </StatusPill>
  )
  return short ? (
    <Tooltip label={detail} withArrow multiline maw={300}>
      <span style={{ display: 'inline-flex' }}>{pill}</span>
    </Tooltip>
  ) : (
    pill
  )
}
