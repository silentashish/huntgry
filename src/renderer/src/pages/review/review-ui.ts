import type { ProposedReframing, ReviewItem, ReviewState } from '@shared/review-types'
import type { UiTone } from '../../components/ui'

/** The list filter above the results (Figma Review — Detail: All · Unreviewed · Attention). */
export type ReviewFilter = 'all' | 'unreviewed' | 'attention'

/** Pill tone of each review state: Unreviewed waits (warning), Needs attention is the one to act on (ember). */
export const STATE_TONE: Record<ReviewState, UiTone> = {
  unreviewed: 'warning',
  'needs-attention': 'accent',
  approved: 'success',
  discarded: 'neutral'
}

export function filterItems(items: readonly ReviewItem[], filter: ReviewFilter): ReviewItem[] {
  if (filter === 'unreviewed') return items.filter((i) => i.state === 'unreviewed')
  if (filter === 'attention') return items.filter((i) => i.state === 'needs-attention')
  return [...items]
}

/** The page eyebrow: "4 unreviewed · 1 needs attention", or "Nothing waiting". */
export function reviewEyebrow(items: readonly ReviewItem[]): string {
  const unreviewed = items.filter((i) => i.state === 'unreviewed').length
  const attention = items.filter((i) => i.state === 'needs-attention').length
  const parts: string[] = []
  if (unreviewed) parts.push(`${unreviewed} unreviewed`)
  if (attention) parts.push(`${attention} needs attention`)
  return parts.length ? parts.join(' · ') : 'Nothing waiting'
}

/** "just now", "25 min ago", "3 h ago", "2 d ago", then the date. */
export function sinceLabel(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** The revision as shown in the header: its first 7 hex characters. */
export function shortRevision(revision: string): string {
  return revision.slice(0, 7)
}

/**
 * The ticked reframing ids that belong to the reframings on screen, in their order. A reload can
 * bring a new revision with other reframings; only the ones the user was shown are sent.
 */
export function shownTicked(proposed: readonly ProposedReframing[], ticked: ReadonlySet<string>): string[] {
  return proposed.filter((r) => ticked.has(r.id)).map((r) => r.id)
}

/** "R1", "R2"… by position in the list. */
export function reframingLabel(proposed: readonly ProposedReframing[], id: string): string {
  return `R${proposed.findIndex((r) => r.id === id) + 1}`
}

/** The line under Approve: what approving does with the current ticks. */
export function approveHint(proposed: readonly ProposedReframing[], ids: readonly string[]): string {
  if (ids.length === 0) return 'Unlocks Apply for this application. Nothing is saved as a preferred wording.'
  const labels = ids.map((id) => reframingLabel(proposed, id))
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
  return `Unlocks Apply for this application and saves ${list} as ${ids.length === 1 ? 'a preferred wording' : 'preferred wordings'}.`
}

/** The reframings of this result the user rejected (#159), not ticked to keep again. */
export function rejectedHere(proposed: readonly ProposedReframing[], ticked: readonly string[]): ProposedReframing[] {
  return proposed.filter((r) => r.rule?.kind === 'rejected' && !ticked.includes(r.id))
}

/** The line under Re-run: what the re-run sends with the current ticks and rejections. */
export function rerunHint(proposed: readonly ProposedReframing[], ticked: readonly string[]): string {
  const rejected = rejectedHere(proposed, ticked).map((r) => reframingLabel(proposed, r.id))
  const kept = ticked.map((id) => reframingLabel(proposed, id))
  const parts = [
    ...(rejected.length ? [`without ${rejected.join(', ')}`] : []),
    ...(kept.length ? [`keeping ${kept.join(', ')} as written`] : [])
  ]
  return `Redoes this result in the run’s own session with your reframing rules${parts.length ? ` (${parts.join('; ')})` : ''}. It comes back here as Unreviewed with a new revision.`
}

/**
 * The warnings behind `build.warnings`, read from the raw `build-report.json` (soft checks that
 * did not pass, then the style warnings), for the line under Verify. Empty when unreadable.
 */
export function buildWarnings(report: string): string[] {
  try {
    const r = JSON.parse(report) as { verify?: { results?: unknown }; style_warnings?: unknown }
    const results = Array.isArray(r.verify?.results) ? (r.verify.results as { check?: unknown; passed?: unknown; hard?: unknown }[]) : []
    const soft = results.filter((c) => c && c.passed === false && c.hard === false).map((c) => String(c.check).replace(/_/g, ' '))
    const style = Array.isArray(r.style_warnings) ? r.style_warnings.filter((w): w is string => typeof w === 'string') : []
    return [...soft, ...style].map((w) => w.trim()).filter(Boolean)
  } catch {
    return []
  }
}
