import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApplicationRecord } from '@shared/applications-types'
import {
  REVIEW_NOTES_FILE,
  REVIEW_NOTES_INLINE_BYTES,
  type ApprovalsSummary,
  type ApproveReviewInput,
  type DiscardReviewInput,
  type RerunReviewInput,
  type ReviewDetail,
  type ReviewItem,
  type ReviewOutcome,
  type ReviewVia,
  type StandingApproval
} from '@shared/review-types'
import type { RunSummary } from '@shared/runner-types'
import { resolveApplicationFolder } from '../applications/safe-path'
import { readApplication, scanApplications } from '../applications/scan'
import { updateTracking } from '../applications/tracking'
import { MAX_TEXT } from '../cli/command'
import { RUN_ID_PATTERN } from '../cli/runs'
import { HUNTGRY_DIR } from '../workspace/constants'
import { addApprovals, approvalsForPrompt, loadApprovals, removeAllApprovals, removeApproval } from './approvals'
import { parseReviewNotes } from './notes'

/**
 * Review of unattended results (#31): what the Review page shows and does.
 * Electron-free; `review/ipc.ts` calls it for the desktop and #42's gateway
 * will call it for the phone. Every decision is bound to the `revision` the
 * caller was shown: a result that changed on disk meanwhile is refused
 * (`stale`), and so are reframing ids that are not in that revision
 * (`invalid`), without writing anything. Standing approvals are written only
 * as source-fact → wording pairs read from disk, never from client text.
 */

export interface ReviewDeps {
  workspace(): Promise<string>
  /** Sends the user's decisions to the run's session (through the queue when it manages the run). */
  reply(runId: string, text: string, workspace: string): Promise<RunSummary | 'held'>
  /** Tracking changed on disk (the desktop re-lists). */
  changed?(): void
  /** The run is working on this result right now (a turn running, or a reply waiting for a slot). */
  busy?(runId: string): boolean
  now?(): Date
}

export const REVIEW_AUDIT_FILE = 'review-audit.jsonl'

const HEX64 = /^[0-9a-f]{64}$/
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

export function requireApplicationId(id: unknown): string {
  if (typeof id !== 'string' || !id || id.length > 600) throw new Error('Invalid application id.')
  return id
}

export function requireRevision(v: unknown): string {
  if (typeof v !== 'string' || !HEX64.test(v)) throw new Error('Invalid revision.')
  return v
}

export function requireReframingIds(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 200) throw new Error('Invalid reframing ids.')
  for (const id of v) if (typeof id !== 'string' || !HEX64.test(id)) throw new Error('Invalid reframing id.')
  return [...new Set(v as string[])]
}

export function requireAnswers(v: unknown): string {
  if (typeof v !== 'string' || v.length > MAX_TEXT) throw new Error('The answers are too long.')
  return v.trim()
}

export function requireApproveInput(input: unknown): ApproveReviewInput {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  return {
    applicationId: requireApplicationId(p.applicationId),
    revision: requireRevision(p.revision),
    approvedReframingIds: requireReframingIds(p.approvedReframingIds)
  }
}

export function requireRerunInput(input: unknown): RerunReviewInput {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const out: RerunReviewInput = {
    applicationId: requireApplicationId(p.applicationId),
    revision: requireRevision(p.revision),
    answers: requireAnswers(p.answers ?? ''),
    approvedReframingIds: requireReframingIds(p.approvedReframingIds)
  }
  if (!out.answers && out.approvedReframingIds!.length === 0) throw new Error('Type your decisions or tick a reframing first.')
  return out
}

export function requireDiscardInput(input: unknown): DiscardReviewInput {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  return { applicationId: requireApplicationId(p.applicationId), revision: requireRevision(p.revision) }
}

const title = (r: ApplicationRecord) => [r.role, r.company].filter(Boolean).join(' · ')

/** Unreviewed and needs-attention results, newest first. */
export async function listReviews(workspace: string): Promise<ReviewItem[]> {
  const { applications } = await scanApplications(workspace)
  return applications
    .filter((a) => a.tracking.review?.state === 'unreviewed' || a.tracking.review?.state === 'needs-attention')
    .map((a): ReviewItem => {
      const review = a.tracking.review!
      return {
        applicationId: a.id,
        runId: review.runId,
        title: title(a),
        state: review.state as ReviewItem['state'],
        reason: review.reason,
        at: review.at,
        build: a.build,
        hasCover: a.files.includes('cover.pdf'),
        jobUrl: a.jobUrl
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.applicationId.localeCompare(b.applicationId))
}

async function fileInfo(folder: string, file: string): Promise<{ file: string; bytes: number; sha256: string } | null> {
  try {
    const path = join(folder, file)
    const s = await stat(path)
    if (!s.isFile()) return null
    return { file, bytes: s.size, sha256: sha256(await readFile(path)) }
  } catch {
    return null
  }
}

/** Everything the review screen shows, pinned by `revision`. */
export async function reviewDetail(workspace: string, applicationId: string): Promise<ReviewDetail> {
  const folder = await resolveApplicationFolder(workspace, applicationId)
  const record = await readApplication(workspace, folder)
  const review = record.tracking.review
  if (!review) throw new Error('This application has no unattended result to review.')
  const notesText = record.files.includes(REVIEW_NOTES_FILE)
    ? await readFile(join(folder, REVIEW_NOTES_FILE), 'utf8').catch(() => null)
    : null
  const parsed = parseReviewNotes(notesText ?? '')
  const report = record.files.includes('build-report.json')
    ? await readFile(join(folder, 'build-report.json'), 'utf8').catch(() => '')
    : ''
  const artifacts = (
    await Promise.all(
      ['resume.pdf', 'cover.pdf', ...record.resumePages, ...record.coverPages].map((f) => fileInfo(folder, f))
    )
  ).filter((a): a is { file: string; bytes: number; sha256: string } => a !== null)
  const ids = parsed.proposed.map((p) => p.id)
  // The review state is part of the revision: a decision made on what was shown before a re-run,
  // an approval or a new run is stale even when the files did not change (yet).
  const revision = sha256(
    JSON.stringify([
      [review.state, review.runId, review.at],
      notesText ?? '',
      parsed.openGaps,
      ids,
      report,
      artifacts.map((a) => [a.file, a.sha256])
    ])
  )
  return {
    applicationId,
    runId: review.runId,
    title: title(record),
    state: review.state,
    reason: review.reason,
    jobUrl: record.jobUrl,
    reviewNotes: notesText !== null && Buffer.byteLength(notesText) <= REVIEW_NOTES_INLINE_BYTES ? notesText : null,
    parseWarning: notesText === null ? 'This result has no review-notes.md.' : parsed.parseWarning,
    usedApprovals: parsed.usedApprovals,
    openGaps: parsed.openGaps,
    proposedReframings: parsed.proposed,
    verify: { ok: record.build.status === 'pass', report },
    build: record.build,
    artifacts,
    resumePages: record.resumePages,
    coverPages: record.coverPages,
    revision
  }
}

async function audit(workspace: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
  await appendFile(join(workspace, HUNTGRY_DIR, REVIEW_AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf8')
}

const BUSY = 'This result is still being tailored. Decide once the run has finished.'

/** The current detail when its revision is the one the caller saw, else a `stale` outcome. */
async function pinned(
  deps: ReviewDeps,
  workspace: string,
  applicationId: string,
  revision: string,
  idle = true
): Promise<{ detail: ReviewDetail } | { outcome: ReviewOutcome }> {
  const detail = await reviewDetail(workspace, applicationId)
  // Approving or re-running a result its run is still rewriting would act on files about to change.
  if (idle && deps.busy?.(detail.runId)) throw new Error(BUSY)
  if (detail.revision !== revision)
    return { outcome: { ok: false, error: 'stale', message: 'This result changed since it was shown. Reload it and decide again.' } }
  return { detail }
}

/** The proposed reframings behind `ids`, all of which must be in this revision. */
function pick(detail: ReviewDetail, ids: string[]): ReviewDetail['proposedReframings'] | null {
  const known = new Map(detail.proposedReframings.map((p) => [p.id, p]))
  const picked = ids.map((id) => known.get(id))
  return picked.every((p): p is NonNullable<typeof p> => p !== undefined) ? picked : null
}

const INVALID: ReviewOutcome = {
  ok: false,
  error: 'invalid',
  message: 'One of the ticked reframings is not part of this result. Reload it and decide again.'
}

function entriesFor(
  picked: ReviewDetail['proposedReframings'],
  detail: ReviewDetail,
  via: ReviewVia,
  now: Date
): Omit<StandingApproval, 'id'>[] {
  return picked.map((p) => ({
    sourceFact: p.sourceFact,
    wording: p.wording,
    ...(p.requirement ? { requirement: p.requirement } : {}),
    approvedAt: now.toISOString(),
    applicationId: detail.applicationId,
    runId: detail.runId,
    via
  }))
}

export async function approveReview(deps: ReviewDeps, input: ApproveReviewInput, via: ReviewVia): Promise<ReviewOutcome> {
  const workspace = await deps.workspace()
  const p = await pinned(deps, workspace, input.applicationId, input.revision)
  if ('outcome' in p) return p.outcome
  const { detail } = p
  const ids = input.approvedReframingIds ?? []
  const picked = pick(detail, ids)
  if (!picked) return INVALID
  const now = deps.now?.() ?? new Date()
  if (picked.length > 0) await addApprovals(workspace, entriesFor(picked, detail, via, now))
  const folder = await resolveApplicationFolder(workspace, input.applicationId)
  await updateTracking(folder, {
    review: { state: 'approved', runId: detail.runId, at: now.toISOString(), reviewedAt: now.toISOString(), via }
  })
  await audit(workspace, { at: now.toISOString(), action: 'approve', applicationId: input.applicationId, revision: input.revision, ids, via })
  deps.changed?.()
  return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
}

/** What the agent is told on a re-run: the user's decisions, plus the ticked reframings as approved. */
export function rerunMessage(answers: string, approved: { sourceFact: string; wording: string }[]): string {
  const lines = ['The user reviewed the notes.']
  if (approved.length > 0) {
    lines.push('Approved reframings (use them as written):')
    for (const a of approved) lines.push(`- Source fact: ${a.sourceFact}\n  Wording: ${a.wording}`)
  }
  if (answers) lines.push(`Decisions: ${answers}`)
  lines.push(`Apply them, rebuild, verify, and update ${REVIEW_NOTES_FILE}. Everything else in your instructions still applies: never stop to ask.`)
  return lines.join('\n')
}

export async function rerunReview(deps: ReviewDeps, input: RerunReviewInput, via: ReviewVia): Promise<ReviewOutcome> {
  const workspace = await deps.workspace()
  const p = await pinned(deps, workspace, input.applicationId, input.revision)
  if ('outcome' in p) return p.outcome
  const { detail } = p
  const ids = input.approvedReframingIds ?? []
  const picked = pick(detail, ids)
  if (!picked) return INVALID
  if (!RUN_ID_PATTERN.test(detail.runId)) throw new Error('This result has no run to continue.')
  const now = deps.now?.() ?? new Date()
  // The reply first: if the session cannot be resumed nothing else changes.
  await deps.reply(detail.runId, rerunMessage(input.answers, picked), workspace)
  if (picked.length > 0) await addApprovals(workspace, entriesFor(picked, detail, via, now))
  const folder = await resolveApplicationFolder(workspace, input.applicationId)
  await updateTracking(folder, {
    review: { state: 'unreviewed', runId: detail.runId, at: now.toISOString(), reason: 'Re-running with your answers.', via }
  })
  await audit(workspace, { at: now.toISOString(), action: 'rerun', applicationId: input.applicationId, revision: input.revision, ids, via })
  deps.changed?.()
  return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
}

export async function discardReview(deps: ReviewDeps, input: DiscardReviewInput, via: ReviewVia): Promise<ReviewOutcome> {
  const workspace = await deps.workspace()
  // Discarding is allowed while the run works: it only archives the result and blocks Apply.
  const p = await pinned(deps, workspace, input.applicationId, input.revision, false)
  if ('outcome' in p) return p.outcome
  const now = deps.now?.() ?? new Date()
  const folder = await resolveApplicationFolder(workspace, input.applicationId)
  await updateTracking(folder, {
    status: 'archived',
    review: { state: 'discarded', runId: p.detail.runId, at: now.toISOString(), reviewedAt: now.toISOString(), via }
  })
  await audit(workspace, { at: now.toISOString(), action: 'discard', applicationId: input.applicationId, revision: input.revision, via })
  deps.changed?.()
  return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
}

function summary(list: StandingApproval[]): ApprovalsSummary {
  return { approvals: list, leftOut: approvalsForPrompt(list).leftOut }
}

export async function listApprovals(workspace: string): Promise<ApprovalsSummary> {
  return summary(await loadApprovals(workspace))
}

export async function dropApproval(workspace: string, id: string): Promise<ApprovalsSummary> {
  return summary(await removeApproval(workspace, id))
}

export async function dropAllApprovals(workspace: string): Promise<ApprovalsSummary> {
  return summary(await removeAllApprovals(workspace))
}
