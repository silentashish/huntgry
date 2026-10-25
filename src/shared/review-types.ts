import type { ApplicationMatch, BuildSummary } from './applications-types'

/**
 * Review of tailoring results (#31, #158). Every run goes to the end on its
 * own: it uses the bridges it can make honestly and lists each one in
 * `tailoring-notes.md` (resume-tailor notes v2). Results of older unattended
 * runs list what they left out in `review-notes.md` (v1) instead; both parse.
 * A result stays **Unreviewed** (Apply is blocked) until the user approves it
 * here, on the desktop or from the phone (#42). Reframings the user keeps or
 * rejects become reframing rules (#159) that later runs get as preferred
 * wordings or wordings to avoid, keyed by `sha256(sourceFact + "\n" + wording)`.
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

/**
 * A reframing rule (#159): the user's standing decision about one source fact → wording pair,
 * which every later run gets as a caller rule. `preferred`: use this wording as written (a
 * reframing kept on the Review page; the standing approvals of #31 and #158 migrate as these).
 * `rejected`: never use this wording, or a close paraphrase, for that fact; `betterWording`, when
 * the user gave one, is passed as the preferred wording for the fact instead. One rule per pair:
 * the latest decision about it replaces the earlier one.
 */
export type ReframingRuleKind = 'preferred' | 'rejected'

export interface ReframingRule {
  /** sha256 hex of `sourceFact + "\n" + wording` (whitespace-normalised), the reframing's own id. */
  id: string
  kind: ReframingRuleKind
  sourceFact: string
  /** preferred: the wording to use; rejected: the wording not to use. */
  wording: string
  /** rejected only: what to say instead (a preferred wording for the fact). */
  betterWording?: string
  requirement?: string
  /** ISO time of the decision. */
  at: string
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
  /** The reframing rule standing for this pair, if any (#159; the detail only, never parsed from notes). */
  rule?: { kind: ReframingRuleKind; betterWording?: string }
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
  /** The file did not follow the format; nothing can be saved as a reframing rule from it. */
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
   * The reframings the user can tick (they become preferred wordings) or reject (#159): v1 the
   * ones the run left out, v2 the ones it used ("Reframings used"). Same ids either way.
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
  /** Ids from `proposedReframings` of this revision; they become preferred wordings. */
  approvedReframingIds?: string[]
}

export interface RerunReviewInput {
  applicationId: string
  revision: string
  /** Free text sent to the agent (decisions per reframing, anything else); may be empty: the re-run then applies the reframing rules (#159). */
  answers: string
  /** Ticked reframings: told to the agent and saved as preferred wordings. */
  approvedReframingIds?: string[]
}

/** Reject one reframing of the revision on screen (#159): it becomes a `rejected` reframing rule. */
export interface RejectReframingInput {
  applicationId: string
  revision: string
  /** An id from `proposedReframings` of this revision. */
  reframingId: string
  /** What to say instead; passed to later runs as the preferred wording for the fact. */
  betterWording?: string
}

export interface DiscardReviewInput {
  applicationId: string
  revision: string
}

export type ReviewOutcome =
  | { ok: true; detail: ReviewDetail }
  /** The result changed since it was shown (new revision); reload. */
  | { ok: false; error: 'stale' | 'invalid'; message: string }

export interface ReframingRulesSummary {
  /** Newest first. */
  rules: ReframingRule[]
  /** How many of them runs do not get (beyond the prompt cap). */
  leftOut: number
}

export interface ReviewApi {
  list(): Promise<ReviewItem[]>
  get(applicationId: string): Promise<ReviewDetail>
  approve(input: ApproveReviewInput): Promise<ReviewOutcome>
  /** Sends the decisions to the run's own session (through the queue); the result is Unreviewed again. */
  rerun(input: RerunReviewInput): Promise<ReviewOutcome>
  discard(input: DiscardReviewInput): Promise<ReviewOutcome>
  /** Stores a rejected-wording rule (#159); the result keeps its state until it is re-run. */
  reject(input: RejectReframingInput): Promise<ReviewOutcome>
  rules(): Promise<ReframingRulesSummary>
  removeRule(id: string): Promise<ReframingRulesSummary>
  removeAllRules(): Promise<ReframingRulesSummary>
}

export const REVIEW_CHANNELS = {
  list: 'review:list',
  get: 'review:get',
  approve: 'review:approve',
  rerun: 'review:rerun',
  discard: 'review:discard',
  reject: 'review:reject',
  rules: 'review:rules',
  removeRule: 'review:remove-rule',
  removeAllRules: 'review:remove-all-rules'
} as const

/** Most reframing rules sent to a run: newest first, then this many / this size (preferred and avoid together). */
export const RULES_PROMPT_CAP = { entries: 150, bytes: 32 * 1024 } as const

/** Longest better wording a rejection may carry. */
export const MAX_BETTER_WORDING = 2000

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
