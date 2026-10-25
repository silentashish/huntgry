import type { ApplicationMatch, BuildSummary } from './applications-types'

/**
 * Review of tailoring results (#31, #158). Every run goes to the end on its
 * own: it uses the bridges it can make honestly and lists each one in
 * `tailoring-notes.md` (resume-tailor notes v2). Results of older unattended
 * runs list what they left out in `review-notes.md` (v1) instead; both parse.
 * A result stays **Unreviewed** (Apply is blocked) until the user approves it
 * here, on the desktop or from the phone (#42). Ticked reframings become
 * standing approvals that later runs get as preferred wordings, keyed by
 * `sha256(sourceFact + "\n" + wording)`.
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

/**
 * A reframing with its source fact: one a v1 run proposed but did not use (`review-notes.md`), or
 * one a v2 run used (`tailoring-notes.md` → Reframings used).
 */
export interface ProposedReframing {
  id: string
  requirement?: string
  sourceFact: string
  wording: string
  reason?: string
}

/** Which notes file a result carries: `review-notes.md` (v1, #31) or `tailoring-notes.md` (v2, #158). */
export type NotesFormat = 'v1' | 'v2'

/** `review-notes.md` (v1) or `tailoring-notes.md` (v2) parsed. */
export interface ReviewNotes {
  format: NotesFormat
  runId?: string
  /** v1 only: standing approvals the run used. */
  usedApprovals: { sourceFact: string; wording: string }[]
  /** v1 only: reframings the run left out. */
  proposed: ProposedReframing[]
  /** v2 only: requirements the profile meets in the posting's own terms. */
  directHits: string[]
  /** v2 only: the bridges the run used, each with its source fact. */
  reframingsUsed: ProposedReframing[]
  /** v1 "Open gaps" / v2 "Gaps left open". */
  openGaps: string[]
  /** v2 only: date style, cuts, judgement calls. */
  decisions: string[]
  /** v1 "Notes". */
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
  /** The notes inline (≤ 16 KiB): `tailoring-notes.md` v2, or `review-notes.md` v1 for older results; else `null`. */
  reviewNotes: string | null
  /** Which notes the result carries (absent when it has none). Desktop only; the phone reads the same fields. */
  notesFormat?: NotesFormat
  parseWarning?: string
  usedApprovals: { sourceFact: string; wording: string }[]
  openGaps: string[]
  /**
   * The reframings the user can tick (they become standing approvals): v1 the ones the run left
   * out, v2 the ones it used ("Reframings used"). Same ids either way.
   */
  proposedReframings: ProposedReframing[]
  /** v2 only. */
  directHits?: string[]
  /** v2 only. */
  decisions?: string[]
  verify: { ok: boolean; report: string }
  build: BuildSummary
  /** Profile fit vs resume coverage (#151), from `huntgry.json`; not part of `revision`. */
  match?: ApplicationMatch
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

/** Longest notes file sent inline in a `ReviewDetail`. */
export const REVIEW_NOTES_INLINE_BYTES = 16 * 1024

/** v1 notes of an older unattended run (#31); also the name the phone asks for (#42). */
export const REVIEW_NOTES_FILE = 'review-notes.md'

/** v2 notes the resume-tailor skill (v5) writes and `build.py --notes` copies into the folder (#158). */
export const TAILORING_NOTES_FILE = 'tailoring-notes.md'

/** The line that marks `tailoring-notes.md` as v2 (older attended runs wrote free-form tailoring notes). */
export const NOTES_V2_MARKER = '<!-- resume-tailor notes v2 -->'

/** The reason an unattended result carries while its run still works on it (set by the pipeline). */
export const IN_PROGRESS_REASON = 'Still being tailored unattended; not checked yet.'

/** The reason a result carries while its run works on the user's answers (it is Unreviewed, not settled). */
export const RERUN_REASON = 'Re-running with your answers.'

/**
 * A listed result whose run has finished with it: not one marked Unreviewed while its unattended
 * run still works (`IN_PROGRESS_REASON`) or works on the user's answers (`RERUN_REASON`). What the
 * phone and the Dashboard count as waiting for review (#42, #109).
 */
export function isSettledReview(item: Pick<ReviewItem, 'reason'>): boolean {
  return item.reason !== IN_PROGRESS_REASON && item.reason !== RERUN_REASON
}

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
