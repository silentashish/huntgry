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

/** "5 min ago" style time since a refresh; "never" without one. */
export function since(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (!Number.isFinite(minutes)) return 'never'
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}
