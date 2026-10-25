import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApplicationRecord } from '@shared/applications-types'
import {
  MAX_BETTER_WORDING,
  REVIEW_NOTES_INLINE_BYTES,
  TAILORING_NOTES_FILE,
  type ApproveReviewInput,
  type DiscardReviewInput,
  type ReframingRule,
  type ReframingRulesSummary,
  type RejectReframingInput,
  type RerunReviewInput,
  type ReviewDetail,
  type ReviewItem,
  type ReviewOutcome,
  type ReviewTracking,
  type ReviewVia
} from '@shared/review-types'
import type { RunSummary } from '@shared/runner-types'
import { resolveApplicationFolder } from '../applications/safe-path'
import { readApplication, scanApplications } from '../applications/scan'
import { updateTracking } from '../applications/tracking'
import { callerRulesBlock, MAX_TEXT, type CallerRules } from '../cli/command'
import { RUN_ID_PATTERN } from '../cli/runs'
import { RERUN_REASON } from '@shared/review-types'
import { HUNTGRY_DIR } from '../workspace/constants'
import { getReview, sameReview, updateReview, type RecordedReview } from './authority'
import { addRules, loadRules, mergeRules, removeAllRules, removeRule, rulesForPrompt, type RuleEntry } from './approvals'
import { normalizeText } from './notes'
import { boundedText, MAX_NOTES_BYTES, parseResultNotes, readResultNotes } from './notes-file'

/**
 * Review of tailoring results (#31, #158): what the Review page shows and does.
 * Electron-free; `review/ipc.ts` calls it for the desktop and #42's gateway
 * will call it for the phone. Every decision is bound to the `revision` the
 * caller was shown: a result that changed on disk meanwhile is refused
 * (`stale`), and so are reframing ids that are not in that revision
 * (`invalid`), without writing anything. Reframing rules (#159) are written only
 * as source-fact → wording pairs read from disk; the only client text in one is
 * a rejection's better wording.
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
  // Empty answers and no ticks is a plain Re-run (#159): the run is redone with the reframing rules.
  return {
    applicationId: requireApplicationId(p.applicationId),
    revision: requireRevision(p.revision),
    answers: requireAnswers(p.answers ?? ''),
    approvedReframingIds: requireReframingIds(p.approvedReframingIds)
  }
}

export function requireBetterWording(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > MAX_BETTER_WORDING) throw new Error('The better wording is too long.')
  return normalizeText(v) || undefined
}

export function requireRejectInput(input: unknown): RejectReframingInput {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const [reframingId] = requireReframingIds([p.reframingId])
  const out: RejectReframingInput = { applicationId: requireApplicationId(p.applicationId), revision: requireRevision(p.revision), reframingId }
  const better = requireBetterWording(p.betterWording)
  if (better) out.betterWording = better
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

/**
 * Open gaps listed in a result's notes (the phone's list badge, #42): v2 "Gaps left open" or v1
 * "Open gaps"; 0 when the notes are missing, unreadable or too large. Reads the notes only, never
 * hashes the PDFs.
 */
export async function openGapCount(workspace: string, applicationId: string): Promise<number> {
  try {
    const folder = await resolveApplicationFolder(workspace, applicationId)
    const notes = await readResultNotes(folder)
    return notes && notes.text !== null ? parseResultNotes(notes).openGaps.length : 0
  } catch {
    return 0
  }
}

/** Largest notes file (see `notes-file.ts`) / build-report.json read; bigger ones are reported, not parsed. */
export { MAX_NOTES_BYTES }
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

  // tailoring-notes.md v2, or review-notes.md v1 for an older result (same slot in the revision).
  const notes = await readResultNotes(folder, record.files)
  const notesText = notes?.text ?? null
  if (notes?.tooLarge !== undefined) warnings.push(`${notes.file} is too large to read (${kib(notes.tooLarge)}; at most ${kib(MAX_NOTES_BYTES)}).`)
  const parsed = notes ? parseResultNotes(notes) : parseResultNotes({ format: 'v1', text: '' })
  // v2: the reframings the run used are the ones the user can tick or reject (same ids as v1's proposed ones).
  const listed = (parsed.format === 'v2' ? parsed.reframingsUsed : parsed.proposed).slice(0, MAX_LIST)
  const openGaps = parsed.openGaps.slice(0, MAX_LIST)
  if (Math.max(parsed.proposed.length, parsed.reframingsUsed.length, parsed.openGaps.length) > MAX_LIST) warnings.push(`Only the first ${MAX_LIST} reframings and gaps are shown.`)

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
  const notesHash = notes?.tooLarge !== undefined ? await hashFile(join(folder, notes.file)).catch(() => '') : ''
  const ids = listed.map((p) => p.id)
  // The rule standing for each pair (#159). Not part of the revision: a rule is a decision, not the result.
  const rules = new Map((await loadRules(workspace)).map((r) => [r.id, r]))
  const proposed = listed.map((p) => {
    const rule = rules.get(p.id)
    return rule ? { ...p, rule: { kind: rule.kind, ...(rule.betterWording ? { betterWording: rule.betterWording } : {}) } } : p
  })
  // The files only (what an approval vouches for)...
  const contentRevision = sha256(
    JSON.stringify([notesText ?? notesHash, openGaps, ids, verify, artifacts.map((a) => [a.file, a.sha256])])
  )
  // ...and the review state: a decision made on what was shown before a re-run, an approval or a
  // new run is stale even when the files did not change (yet).
  const revision = sha256(JSON.stringify([[review.state, review.runId, review.at], contentRevision]))
  const parseWarning = [!notes ? `This result has no tailoring notes (${TAILORING_NOTES_FILE}).` : notes.text !== null ? parsed.parseWarning : undefined, ...warnings]
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
      ...(notes ? { notesFormat: notes.format } : {}),
      ...(parseWarning ? { parseWarning } : {}),
      usedApprovals: parsed.usedApprovals.slice(0, MAX_LIST),
      openGaps,
      proposedReframings: proposed,
      ...(parsed.format === 'v2' ? { directHits: parsed.directHits.slice(0, MAX_LIST), decisions: parsed.decisions.slice(0, MAX_LIST) } : {}),
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
  now: Date,
  kind: ReframingRule['kind'] = 'preferred',
  betterWording?: string
): RuleEntry[] {
  return picked.map((p) => ({
    kind,
    sourceFact: p.sourceFact,
    wording: p.wording,
    ...(betterWording ? { betterWording } : {}),
    ...(p.requirement ? { requirement: p.requirement } : {}),
    at: now.toISOString(),
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
      if (picked.length > 0) await addRules(workspace, entriesFor(picked, detail, via, now))
      await audit(workspace, { at, action: 'approve', applicationId: input.applicationId, revision: input.revision, ids, via })
      deps.changed?.()
      return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
    })
  )
}

/** Shared with the renderer (#109): the Dashboard counts results to review with the same rule. */
export { isSettledReview, RERUN_REASON } from '@shared/review-types'

/**
 * What the agent is told on a re-run: the reframings of this result the user rejected (with the
 * better wording when given), the ones ticked to keep, the user's decisions, and the caller rules
 * as they stand now (#159). The rules are repeated here because a continued session keeps the
 * system prompt it started with; a run started later gets them from `buildSystemPrompt`.
 */
export function rerunMessage(
  answers: string,
  approved: { sourceFact: string; wording: string }[],
  rejected: { sourceFact: string; wording: string; betterWording?: string }[] = [],
  rules?: CallerRules
): string {
  const lines = ['The user reviewed the notes.']
  if (rejected.length > 0) {
    lines.push('Rejected reframings (do not use these wordings, or a close paraphrase, for that fact):')
    for (const r of rejected)
      lines.push(`- Source fact: ${r.sourceFact}\n  Rejected wording: ${r.wording}${r.betterWording ? `\n  Use instead: ${r.betterWording}` : ''}`)
  }
  if (approved.length > 0) {
    lines.push('Preferred wordings (use them as written):')
    for (const a of approved) lines.push(`- Source fact: ${a.sourceFact}\n  Wording: ${a.wording}`)
  }
  if (answers) lines.push(`Decisions: ${answers}`)
  if (rules) lines.push(...callerRulesBlock(rules))
  lines.push(`Apply them, rebuild, verify, and update ${TAILORING_NOTES_FILE} (pass it to build.py with --notes). Everything else in your instructions still applies: never stop to ask.`)
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
      const rerunning: RecordedReview = { state: 'unreviewed', runId: detail.runId, at, reason: RERUN_REASON, via }
      const before = await getReview(workspace, input.applicationId)
      if (!(await decide(workspace, input.applicationId, p.review, rerunning))) return STALE
      // The rules as they will stand once the ticks are saved; the rejections of this result spelled out.
      const rules = mergeRules(await loadRules(workspace), entriesFor(picked, detail, via, now))
      const { preferred, avoid } = rulesForPrompt(rules)
      // A better wording rejected since is not offered as "Use instead" (the caller rules avoid it).
      const avoided = (fact: string, wording: string) => avoid.some((a) => a.sourceFact === normalizeText(fact) && a.wording === normalizeText(wording))
      const rejected = detail.proposedReframings
        .filter((p) => p.rule?.kind === 'rejected' && !ids.includes(p.id))
        .map((p) => {
          const better = p.rule?.betterWording
          return { sourceFact: p.sourceFact, wording: p.wording, ...(better && !avoided(p.sourceFact, better) ? { betterWording: better } : {}) }
        })
      try {
        await deps.reply(detail.runId, rerunMessage(input.answers, picked, rejected, { preferred, avoid }), workspace)
      } catch (err) {
        // The session could not be resumed: put back what was there, unless something else wrote meanwhile.
        if (before) await decide(workspace, input.applicationId, rerunning, before).catch(() => false)
        throw err
      }
      if (picked.length > 0) await addRules(workspace, entriesFor(picked, detail, via, now))
      await audit(workspace, { at, action: 'rerun', applicationId: input.applicationId, revision: input.revision, ids, rejected: rejected.length, via })
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

/**
 * Rejects one reframing of the revision on screen (#159): it becomes a `rejected` reframing rule
 * (the pair read from disk, plus the user's better wording). The result itself keeps its state
 * and revision; Re-run redoes it with the rules. Allowed while the run works (it writes no file
 * of the result); a revision that changed meanwhile is `stale`.
 */
export function rejectReframing(deps: ReviewDeps, input: RejectReframingInput, via: ReviewVia): Promise<ReviewOutcome> {
  return deps.workspace().then((workspace) =>
    withDecisionLock(workspace, input.applicationId, async () => {
      const p = await pinned(deps, workspace, input.applicationId, input.revision, false)
      if ('outcome' in p) return p.outcome
      const { detail } = p
      const picked = pick(detail, [input.reframingId])
      if (!picked) return INVALID
      const [r] = picked
      if (input.betterWording && normalizeText(input.betterWording) === normalizeText(r.wording))
        return { ok: false, error: 'invalid', message: 'The better wording is the wording you are rejecting.' }
      const now = deps.now?.() ?? new Date()
      await addRules(workspace, entriesFor(picked, detail, via, now, 'rejected', input.betterWording))
      await audit(workspace, { at: now.toISOString(), action: 'reject', applicationId: input.applicationId, revision: input.revision, ids: [r.id], better: !!input.betterWording, via })
      deps.changed?.()
      return { ok: true, detail: await reviewDetail(workspace, input.applicationId) }
    })
  )
}

function summary(list: ReframingRule[]): ReframingRulesSummary {
  return { rules: list, leftOut: rulesForPrompt(list).leftOut }
}

export async function listRules(workspace: string): Promise<ReframingRulesSummary> {
  return summary(await loadRules(workspace))
}

export async function dropRule(workspace: string, id: string): Promise<ReframingRulesSummary> {
  return summary(await removeRule(workspace, id))
}

export async function dropAllRules(workspace: string): Promise<ReframingRulesSummary> {
  return summary(await removeAllRules(workspace))
}
