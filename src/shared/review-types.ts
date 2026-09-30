import type { BuildSummary } from './applications-types'

/**
 * Review of unattended tailoring results (#31). An unattended run may use only
 * master-profile facts and standing approvals; everything else it leaves out
 * and lists in `review-notes.md`. The result stays **Unreviewed** (Apply is
 * blocked) until the user approves it here, on the desktop or, later, from the
 * phone (#42). Approved reframings become standing approvals that later
 * unattended runs may reuse, keyed by `sha256(sourceFact + "\n" + wording)`.
 */

export type ReviewState = 'unreviewed' | 'needs-attention' | 'approved' | 'discarded'

/** `huntgry.json` → `review`: how an unattended result stands. */
export interface ReviewTracking {
  state: ReviewState
  /** The run that produced this result. */
  runId: string
  /** ISO time the state was set. */
  at: string
  /** needs-attention: failed verify checks / "no review notes" / "stopped with a question". */
  reason?: string
  reviewedAt?: string
  via?: ReviewVia
}

export type ReviewVia = 'desktop' | `phone:${string}`

/** One reframing the user approved: later unattended runs may use it as it is (same fact, same wording). */
export interface StandingApproval {
  /** sha256 hex of `sourceFact + "\n" + wording` (whitespace-normalised). */
  id: string
  sourceFact: string
  wording: string
  requirement?: string
  approvedAt: string
  applicationId: string
  runId: string
  via: ReviewVia
}

/** A reframing an unattended run proposed but did not use (from `review-notes.md`). */
export interface ProposedReframing {
  id: string
  requirement?: string
  sourceFact: string
  wording: string
  reason?: string
}

/** `review-notes.md` parsed. */
export interface ReviewNotes {
  runId?: string
  usedApprovals: { sourceFact: string; wording: string }[]
  proposed: ProposedReframing[]
  openGaps: string[]
  notes: string
  /** The file did not follow the format; nothing can be saved as a standing approval from it. */
  parseWarning?: string
}

export interface ReviewItem {
  applicationId: string
  runId: string
  /** `Role · Company`. */
  title: string
  state: 'unreviewed' | 'needs-attention'
  reason?: string
  at: string
  build: BuildSummary
  hasCover: boolean
  jobUrl: string | null
}

/** What the review screen shows; `revision` pins it so approve / rerun / discard act on what was seen (ADR-0001). */
export interface ReviewDetail {
  applicationId: string
  runId: string
  title: string
  state: ReviewState
  reason?: string
  jobUrl: string | null
  /** `review-notes.md` inline (≤ 16 KiB), else `null`. */
  reviewNotes: string | null
  parseWarning?: string
  usedApprovals: { sourceFact: string; wording: string }[]
  openGaps: string[]
  proposedReframings: ProposedReframing[]
  verify: { ok: boolean; report: string }
  build: BuildSummary
  artifacts: { file: string; bytes: number; sha256: string }[]
  resumePages: string[]
  coverPages: string[]
  /** sha256 over the notes, gaps, reframing ids, verify report and every artifact hash. */
  revision: string
}

export interface ApproveReviewInput {
  applicationId: string
  revision: string
  /** Ids from `proposedReframings` of this revision; they become standing approvals. */
  approvedReframingIds?: string[]
}

export interface RerunReviewInput {
  applicationId: string
  revision: string
  /** Free text sent to the agent (decisions per reframing, anything else). */
  answers: string
  /** Ticked reframings: told to the agent and saved as standing approvals. */
  approvedReframingIds?: string[]
}

export interface DiscardReviewInput {
  applicationId: string
  revision: string
}

export type ReviewOutcome =
  | { ok: true; detail: ReviewDetail }
  /** The result changed since it was shown (new revision); reload. */
  | { ok: false; error: 'stale' | 'invalid'; message: string }

export interface ApprovalsSummary {
  approvals: StandingApproval[]
  /** How many of them unattended runs do not get (beyond the prompt cap). */
  leftOut: number
}

export interface ReviewApi {
  list(): Promise<ReviewItem[]>
  get(applicationId: string): Promise<ReviewDetail>
  approve(input: ApproveReviewInput): Promise<ReviewOutcome>
  /** Sends the decisions to the run's own session (through the queue); the result is Unreviewed again. */
  rerun(input: RerunReviewInput): Promise<ReviewOutcome>
  discard(input: DiscardReviewInput): Promise<ReviewOutcome>
  approvals(): Promise<ApprovalsSummary>
  removeApproval(id: string): Promise<ApprovalsSummary>
  removeAllApprovals(): Promise<ApprovalsSummary>
}

export const REVIEW_CHANNELS = {
  list: 'review:list',
  get: 'review:get',
  approve: 'review:approve',
  rerun: 'review:rerun',
  discard: 'review:discard',
  approvals: 'review:approvals',
  removeApproval: 'review:remove-approval',
  removeAllApprovals: 'review:remove-all-approvals'
} as const

/** Most standing approvals sent to an unattended run: newest first, then this many / this size. */
export const APPROVALS_PROMPT_CAP = { entries: 150, bytes: 32 * 1024 } as const

/** Longest `review-notes.md` sent inline in a `ReviewDetail`. */
export const REVIEW_NOTES_INLINE_BYTES = 16 * 1024

export const REVIEW_NOTES_FILE = 'review-notes.md'

/** Why an application cannot be applied to because of its review state, or `null` (shared by main and the UI). */
export function reviewBlocker(review: ReviewTracking | undefined): string | null {
  switch (review?.state) {
    case 'unreviewed':
      return 'This result is Unreviewed: approve it on the Review page first.'
    case 'needs-attention':
      return 'This result needs attention: check it on the Review page first.'
    case 'discarded':
      return 'This result was discarded on the Review page.'
    default:
      return null
  }
}

export const REVIEW_STATE_LABEL: Record<ReviewState, { label: string; color: string }> = {
  unreviewed: { label: 'Unreviewed', color: 'yellow' },
  'needs-attention': { label: 'Needs attention', color: 'orange' },
  approved: { label: 'Approved', color: 'green' },
  discarded: { label: 'Discarded', color: 'gray' }
}
