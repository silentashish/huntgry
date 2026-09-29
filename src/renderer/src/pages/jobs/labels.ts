import type { JobSourceId } from '@shared/jobs-types'

export const SOURCE_LABEL: Record<JobSourceId, string> = {
  'hiring.cafe': 'hiring.cafe',
  indeed: 'Indeed',
  url: 'Added by URL',
  pasted: 'Pasted'
}

/** "3 days ago" style age of a posting. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? '1 month ago' : `${months} months ago`
}
