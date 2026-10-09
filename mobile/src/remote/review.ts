/**
 * The phone's rules for a review decision (#42), kept apart from the screens so they are
 * tested in Node. The desktop is the authority (it rebuilds the result from disk and answers
 * `stale`, `denied` or `invalid`); these rules only make sure the phone never *offers* more
 * than the desktop would allow:
 *
 * - a decision echoes the exact `revision` the phone was served, and only reframing ids that
 *   detail listed (in its order, no repeats, never text);
 * - Approve is enabled only after page 1 of each preview listed for **that** revision has
 *   loaded and matched the listed SHA-256 (the PDFs when there are no previews);
 * - a detail marked `truncated` left something out: approve it on the Mac;
 * - an approved or discarded result offers nothing.
 */

import type { RemoteFile, ReviewDetail } from '@huntgry/remote-protocol'
import { pageNumber } from './files'

/** The desktop's `NO_RUN`: a result whose run is gone cannot be re-run. */
export const NO_RUN = 'none'

export const REVIEW_COPY = {
  stale: 'This result changed on your Mac since you opened it. Here is the new version: check it again before you decide.',
  denied: 'Your Mac needs to show you this result again before you decide (it may have restarted). It has been reloaded: check it and decide again.',
  changed: 'This result changed on your Mac. Check it again before you decide.',
  truncated: 'Part of this result did not fit on the phone. Approve it on the Mac.',
  noPreviews: 'There are no previews of this result to check. Approve it on the Mac.',
  loading: 'Approve unlocks once page 1 of each document has loaded.',
  approved: 'Approved. Nothing was applied or submitted.',
  discarded: 'Discarded on your Mac. Every file is kept.',
  rerun: 'Sent to the same run. The result comes back here as Unreviewed with a new revision.'
} as const

/** Unreviewed or Needs attention: the only states the desktop decides on. */
export function isDecidable(d: ReviewDetail): boolean {
  return d.state === undefined || d.state === 'unreviewed' || d.state === 'needs-attention'
}

export function canRerun(d: ReviewDetail): boolean {
  return isDecidable(d) && d.runId !== NO_RUN
}

/** The previews that must load before Approve: every page 1, or the PDFs when no preview is listed. */
export function requiredPreviews(d: ReviewDetail): RemoteFile[] {
  const firstPages = d.artifacts.filter((a) => pageNumber(a.file) === 1).map((a) => a.file)
  if (firstPages.length > 0) return firstPages
  return d.artifacts.filter((a) => a.file.endsWith('.pdf')).map((a) => a.file)
}

export type ApprovalGate = { ok: true } | { ok: false; reason: 'decided' | 'truncated' | 'no-previews' | 'loading'; message: string }

/**
 * Whether Approve may be pressed. `verified(file)` is the SHA-256 of the file the phone holds,
 * reassembled and checked, or null.
 */
export function approvalGate(d: ReviewDetail, verified: (file: RemoteFile) => string | null): ApprovalGate {
  if (!isDecidable(d)) return { ok: false, reason: 'decided', message: d.state === 'approved' ? 'Approved on your Mac.' : 'Discarded on your Mac.' }
  if (d.truncated) return { ok: false, reason: 'truncated', message: REVIEW_COPY.truncated }
  const required = requiredPreviews(d)
  if (required.length === 0) return { ok: false, reason: 'no-previews', message: REVIEW_COPY.noPreviews }
  for (const file of required) {
    const listed = d.artifacts.find((a) => a.file === file)
    if (!listed || verified(file) !== listed.sha256) return { ok: false, reason: 'loading', message: REVIEW_COPY.loading }
  }
  return { ok: true }
}

/** The ticked ids this detail listed, in its order: never an id from another revision or result. */
export function approvalIds(d: ReviewDetail, ticked: Iterable<string>): string[] {
  const set = new Set(ticked)
  return d.proposedReframings.filter((p) => set.has(p.id)).map((p) => p.id)
}

/** Ticks that survive a new revision: the same reframing (same id) still listed. */
export function keepTicks(d: ReviewDetail, ticked: Iterable<string>): Set<string> {
  return new Set(approvalIds(d, ticked))
}

/** "3f9a2c1" */
export function shortRevision(revision: string): string {
  return revision.slice(0, 7)
}

export const REVIEW_STATE: Record<NonNullable<ReviewDetail['state']>, { label: string; tone: 'warning' | 'ember' | 'success' | 'neutral' }> = {
  unreviewed: { label: 'Unreviewed', tone: 'warning' },
  'needs-attention': { label: 'Needs attention', tone: 'ember' },
  approved: { label: 'Approved', tone: 'success' },
  discarded: { label: 'Discarded', tone: 'neutral' }
}
