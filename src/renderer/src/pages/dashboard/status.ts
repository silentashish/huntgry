import type { ApplicationStatus } from '@shared/applications-types'

export const STATUS_META: Record<ApplicationStatus, { label: string; color: string }> = {
  generated: { label: 'Generated', color: 'gray' },
  applied: { label: 'Applied', color: 'blue' },
  interviewing: { label: 'Interviewing', color: 'violet' },
  offer: { label: 'Offer', color: 'green' },
  rejected: { label: 'Rejected', color: 'red' },
  archived: { label: 'Archived', color: 'dark' }
}
