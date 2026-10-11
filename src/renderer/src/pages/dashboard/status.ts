import type { ApplicationStatus } from '@shared/applications-types'
import type { ReviewState } from '@shared/review-types'
import type { UiTone } from '../../components/ui'

/** `color` is the Mantine colour name (Selects, older callers); `tone` the Scent Trail pill tone. */
export const STATUS_META: Record<ApplicationStatus, { label: string; color: string; tone: UiTone }> = {
  generated: { label: 'Generated', color: 'gray', tone: 'neutral' },
  applied: { label: 'Applied', color: 'blue', tone: 'info' },
  interviewing: { label: 'Interviewing', color: 'violet', tone: 'review' },
  offer: { label: 'Offer', color: 'green', tone: 'success' },
  rejected: { label: 'Rejected', color: 'red', tone: 'danger' },
  archived: { label: 'Archived', color: 'dark', tone: 'neutral' }
}

/** Review states as outline pills (Figma: Unreviewed warning, Needs attention ember, Approved success). */
export const REVIEW_TONE: Record<ReviewState, UiTone> = {
  unreviewed: 'warning',
  'needs-attention': 'accent',
  approved: 'success',
  discarded: 'neutral'
}
