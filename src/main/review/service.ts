import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
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
  type ReviewTracking,
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
import { getReview, sameReview, updateReview, type RecordedReview } from './authority'
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

/** Largest review-notes.md / build-report.json read; bigger ones are reported, not parsed. */
export const MAX_NOTES_BYTES = 256 * 1024
export const MAX_REPORT_BYTES = 1024 * 1024
/** Most page images per document hashed into a revision. */
const MAX_PAGES = 30
/** Most reframings / gaps taken from one notes file. */
const MAX_LIST = 200

/** sha256 of a file, streamed (a large PDF is never held in memory). */
function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

async function fileInfo(folder: string, file: string): Promise<{ file: string; bytes: number; sha256: string } | null> {
  try {
    const path = join(folder, file)
    const s = await stat(path)
    if (!s.isFile()) return null
    return { file, bytes: s.size, sha256: await hashFile(path) }
  } catch {
    return null
  }
}

/** A text file read only when it is at most `max` bytes: `{ text }`, `{ tooLarge }` or `null` when missing. */
async function boundedText(path: string, max: number): Promise<{ text: string } | { tooLarge: number } | null> {
  const s = await stat(path).catch(() => null)
  if (!s || !s.isFile()) return null
  if (s.size > max) return { tooLarge: s.size }
  const text = await readFile(path, 'utf8').catch(() => null)
  return text === null ? null : { text }
}

const kib = (n: number) => `${Math.round(n / 1024)} KiB`

/** Everything the review screen shows, pinned by `revision`. */
export async function reviewDetail(workspace: string, applicationId: string): Promise<ReviewDetail> {
  return (await detailWithRecord(workspace, applicationId)).detail
}

async function detailWithRecord(
  workspace: string,
  applicationId: string
): Promise<{ detail: ReviewDetail; contentRevision: string; review: ReviewTracking }> {
  const folder = await resolveApplicationFolder(workspace, applicationId)
  const record = await readApplication(workspace, folder)
  // readApplication gives the recorded state (or its fail-closed stand-in); the record adds the main-run verify.
  const review = record.tracking.review
  if (!review) throw new Error('This application has no unattended result to review.')
  const recorded = await getReview(workspace, applicationId)
  const warnings: string[] = []

  const notes = record.files.includes(REVIEW_NOTES_FILE) ? await boundedText(join(folder, REVIEW_NOTES_FILE), MAX_NOTES_BYTES) : null
  const notesText = notes && 'text' in notes ? notes.text : null
  if (notes && 'tooLarge' in notes) warnings.push(`review-notes.md is too large to read (${kib(notes.tooLarge)}; at most ${kib(MAX_NOTES_BYTES)}).`)
  const parsed = parseReviewNotes(notesText ?? '')
  const proposed = parsed.proposed.slice(0, MAX_LIST)
  const openGaps = parsed.openGaps.slice(0, MAX_LIST)
  if (parsed.proposed.length > MAX_LIST || parsed.openGaps.length > MAX_LIST) warnings.push(`Only the first ${MAX_LIST} reframings and gaps are shown.`)

  const reportFile = record.files.includes('build-report.json') ? await boundedText(join(folder, 'build-report.json'), MAX_REPORT_BYTES) : null
  if (reportFile && 'tooLarge' in reportFile) warnings.push(`build-report.json is too large to read (${kib(reportFile.tooLarge)}).`)
  const buildReport = reportFile && 'text' in reportFile ? reportFile.text : ''
  // No build report: the verify gate ran verify.py itself and recorded what it said.
  const verify = buildReport || !recorded?.verify ? { ok: record.build.status === 'pass', report: buildReport } : recorded.verify

  const pages = [...record.resumePages.slice(0, MAX_PAGES), ...record.coverPages.slice(0, MAX_PAGES)]
  const artifacts: { file: string; bytes: number; sha256: string }[] = []
  // One at a time: bounded memory and file handles however many pages there are.
  for (const f of ['resume.pdf', 'cover.pdf', ...pages]) {
    const info = await fileInfo(folder, f)
    if (info) artifacts.push(info)
  }
  const notesHash = notes && 'tooLarge' in notes ? await hashFile(join(folder, REVIEW_NOTES_FILE)).catch(() => '') : ''
  const ids = proposed.map((p) => p.id)
  // The files only (what an approval vouches for)...
  const contentRevision = sha256(
    JSON.stringify([notesText ?? notesHash, openGaps, ids, verify, artifacts.map((a) => [a.file, a.sha256])])
  )
  // ...and the review state: a decision made on what was shown before a re-run, an approval or a
  // new run is stale even when the files did not change (yet).
  const revision = sha256(JSON.stringify([[review.state, review.runId, review.at], contentRevision]))
  const parseWarning = [notesText === null && !notes ? 'This result has no review-notes.md.' : parsed.parseWarning, ...warnings]
    .filter(Boolean)
    .join(' ')
  return {
    contentRevision,
    review,
    detail: {
      applicationId,
      runId: review.runId,
      title: title(record),
      state: review.state,
      reason: review.reason,
      jobUrl: record.jobUrl,
      reviewNotes: notesText !== null && Buffer.byteLength(notesText) <= REVIEW_NOTES_INLINE_BYTES ? notesText : null,
      ...(parseWarning ? { parseWarning } : {}),
      usedApprovals: parsed.usedApprovals.slice(0, MAX_LIST),
      openGaps,
      proposedReframings: proposed,
      verify,
      build: record.build,
      artifacts,
      resumePages: record.resumePages,
      coverPages: record.coverPages,
      revision
    }
  }
}

/** Files-only revision of a result (what an approval vouches for); Apply compares it with the approved one. */
export async function contentRevisionOf(workspace: string, applicationId: string): Promise<string> {
  return (await detailWithRecord(workspace, applicationId)).contentRevision
}

/**
 * Why an approved result may not be applied: its files changed since the approval (or the approval
 * carries no revision). `null` when the approval still holds or the result is not approved.
 */
export async function approvalDrift(workspace: string, applicationId: string): Promise<string | null> {
  const recorded = await getReview(workspace, applicationId)
  if (recorded?.state !== 'approved') return null
  const current = await contentRevisionOf(workspace, applicationId).catch(() => null)
  if (!recorded.contentRevision || current !== recorded.contentRevision)
    return 'This result changed since you approved it: check it on the Review page again.'
  return null
}

async function audit(workspace: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
  await appendFile(join(workspace, HUNTGRY_DIR, REVIEW_AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf8')
}

const BUSY = 'This result is still being tailored. Decide once the run has finished.'
const STALE: ReviewOutcome = { ok: false, error: 'stale', message: 'This result changed since it was shown. Reload it and decide again.' }

const decisionLocks = new Map<string, Promise<unknown>>()

/**
 * One decision at a time per application (approve, re-run, discard): the revision check, the
 * state change and the standing-approval write happen under it, so two decisions made on the
 * same revision cannot both pass.
 */
function withDecisionLock<T>(workspace: string, applicationId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${workspace}\n${applicationId}`
  const previous = decisionLocks.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  decisionLocks.set(key, tail)
  void tail.then(() => {
    if (decisionLocks.get(key) === tail) decisionLocks.delete(key)
  })
  return run
}

/** The current detail when its revision is the one the caller saw, else a `stale` outcome. */
async function pinned(
  deps: ReviewDeps,
  workspace: string,
  applicationId: string,
  revision: string,
  idle = true
): Promise<{ detail: ReviewDetail; contentRevision: string; review: ReviewTracking } | { outcome: ReviewOutcome }> {
  const d = await detailWithRecord(workspace, applicationId)
  // Approving or re-running a result its run is still rewriting would act on files about to change.
  if (idle && deps.busy?.(d.detail.runId)) throw new Error(BUSY)
  if (d.detail.revision !== revision) return { outcome: STALE }
  return d
}

/**
 * Records `next` only if the review is still the one the decision was made on (anything else
 * wrote meanwhile: a continuation, the verify gate): the store's own atomic compare-and-set.
 */
async function decide(
  workspace: string,
  applicationId: string,
  seen: ReviewTracking,
  next: RecordedReview,
  /**
   * Approve and discard decide on the files as they are, so the verify gate's own verify.py report
   * stays with them (it is part of the content revision an approval vouches for). A re-run does not
   * keep it: the next build gets its own.
   */
  keepVerify = false
): Promise<boolean> {
  const { written } = await updateReview(workspace, applicationId, (current) => {
    // A fail-closed stand-in (no recorded state) is "seen" as nothing recorded.
    const expected = seen.runId === '' && !current ? true : sameReview(current, seen)
    if (!expected) return null
    return keepVerify && current?.verify && !next.verify ? { ...next, verify: current.verify } : next
  })
  return written
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

export function approveReview(deps: ReviewDeps, input: ApproveReviewInput, via: ReviewVia): Promise<ReviewOutcome> {
  return deps.workspace().then((workspace) =>
    withDecisionLock(workspace, input.applicationId, async () => {
      const p = await pinned(deps, workspace, input.applicationId, input.revision)
      if ('outcome' in p) return p.outcome
      const { detail } = p
      const ids = input.approvedReframingIds ?? []
      const picked = pick(detail, ids)
      if (!picked) return INVALID
      const now = deps.now?.() ?? new Date()
      const at = now.toISOString()
      const approved: RecordedReview = {
        state: 'approved',
        runId: detail.runId,
        at,
        reviewedAt: at,
        via,
        contentRevision: p.contentRevision
      }
      if (!(await decide(workspace, input.applicationId, p.review, approved, true))) return STALE
      if (picked.length > 0) await addApprovals(workspace, entriesFor(picked, detail, via, now))
      await audit(workspace, { at, action: 'approve', applicationId: input.applicationId, revision: input.revision, ids, via })
      deps.changed?.()
      return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
    })
  )
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

export function rerunReview(deps: ReviewDeps, input: RerunReviewInput, via: ReviewVia): Promise<ReviewOutcome> {
  return deps.workspace().then((workspace) =>
    withDecisionLock(workspace, input.applicationId, async () => {
      const p = await pinned(deps, workspace, input.applicationId, input.revision)
      if ('outcome' in p) return p.outcome
      const { detail } = p
      const ids = input.approvedReframingIds ?? []
      const picked = pick(detail, ids)
      if (!picked) return INVALID
      if (!RUN_ID_PATTERN.test(detail.runId)) throw new Error('This result has no run to continue.')
      const now = deps.now?.() ?? new Date()
      const at = now.toISOString()
      // Unreviewed before the reply leaves: from here on the files are the agent's again.
      const rerunning: RecordedReview = { state: 'unreviewed', runId: detail.runId, at, reason: 'Re-running with your answers.', via }
      const before = await getReview(workspace, input.applicationId)
      if (!(await decide(workspace, input.applicationId, p.review, rerunning))) return STALE
      try {
        await deps.reply(detail.runId, rerunMessage(input.answers, picked), workspace)
      } catch (err) {
        // The session could not be resumed: put back what was there, unless something else wrote meanwhile.
        if (before) await decide(workspace, input.applicationId, rerunning, before).catch(() => false)
        throw err
      }
      if (picked.length > 0) await addApprovals(workspace, entriesFor(picked, detail, via, now))
      await audit(workspace, { at, action: 'rerun', applicationId: input.applicationId, revision: input.revision, ids, via })
      deps.changed?.()
      return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
    })
  )
}

export function discardReview(deps: ReviewDeps, input: DiscardReviewInput, via: ReviewVia): Promise<ReviewOutcome> {
  return deps.workspace().then((workspace) =>
    withDecisionLock(workspace, input.applicationId, async () => {
      // Discarding is allowed while the run works: it only archives the result and blocks Apply;
      // the verify gate keeps a discarded result discarded.
      const p = await pinned(deps, workspace, input.applicationId, input.revision, false)
      if ('outcome' in p) return p.outcome
      const now = deps.now?.() ?? new Date()
      const at = now.toISOString()
      const discarded: RecordedReview = { state: 'discarded', runId: p.detail.runId, at, reviewedAt: at, via }
      if (!(await decide(workspace, input.applicationId, p.review, discarded, true))) return STALE
      const folder = await resolveApplicationFolder(workspace, input.applicationId)
      await updateTracking(folder, { status: 'archived' })
      await audit(workspace, { at, action: 'discard', applicationId: input.applicationId, revision: input.revision, via })
      deps.changed?.()
      return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
    })
  )
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
