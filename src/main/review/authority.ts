import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReviewTracking } from '@shared/review-types'
import { normalizeReview } from '../applications/tracking'

/**
 * Where the review decisions and the standing approvals live (#31). Not in the
 * workspace: every agent may write there (Claude `acceptEdits`, Codex
 * `workspace-write`, Antigravity's sandbox), so a posting with a prompt
 * injection could otherwise approve its own result or plant a standing
 * approval. This folder is under the app's userData, outside every agent's
 * writable roots, keyed by the workspace path:
 *
 *   <userData>/review/<sha256(workspace)[0..32]>/reviews.json     applicationId → review state
 *   <userData>/review/<sha256(workspace)[0..32]>/approvals.json   standing approvals
 *
 * Only main writes here. `huntgry.json` no longer carries the review state;
 * a `review` found there was not written by Huntgry and fails closed.
 */

let rootProvider: () => string = () => join(tmpdir(), 'huntgry-review-authority')

/** The app points this at `<userData>/review` at startup; tests at a temp folder. */
export function setReviewAuthorityRoot(provider: string | (() => string)): void {
  rootProvider = typeof provider === 'string' ? () => provider : provider
}

export function authorityDir(workspace: string): string {
  const key = createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 32)
  return join(rootProvider(), key)
}

export const REVIEWS_FILE = 'reviews.json'
export const reviewsFile = (workspace: string): string => join(authorityDir(workspace), REVIEWS_FILE)

/** A review state as recorded by main, plus what the gate needs to check an approval later. */
export interface RecordedReview extends ReviewTracking {
  /** Approved: the content revision (files only) the user approved; Apply refuses once the files differ. */
  contentRevision?: string
  /** The verify gate's own check when the build left no build-report.json (verify.py output, truncated). */
  verify?: { ok: boolean; report: string }
}

type Reviews = Record<string, RecordedReview>

const cache = new Map<string, { mtimeMs: number; size: number; reviews: Reviews }>()
const chains = new Map<string, Promise<unknown>>()

function normalize(raw: unknown): Reviews {
  const out: Reviews = {}
  if (typeof raw !== 'object' || raw === null) return out
  const map = (raw as { reviews?: unknown }).reviews
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return out
  for (const [id, value] of Object.entries(map as Record<string, unknown>)) {
    const review = normalizeReview(value)
    if (!review) continue
    const v = value as Record<string, unknown>
    const rec: RecordedReview = review
    if (typeof v.contentRevision === 'string' && /^[0-9a-f]{64}$/.test(v.contentRevision)) rec.contentRevision = v.contentRevision
    const verify = v.verify as Record<string, unknown> | undefined
    if (verify && typeof verify.ok === 'boolean' && typeof verify.report === 'string')
      rec.verify = { ok: verify.ok, report: verify.report.slice(0, 8000) }
    out[id] = rec
  }
  return out
}

async function load(workspace: string): Promise<Reviews> {
  const file = reviewsFile(workspace)
  const s = await stat(file).catch(() => null)
  if (!s) {
    cache.delete(file)
    return {}
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit.reviews
  let reviews: Reviews = {}
  try {
    reviews = normalize(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    // A broken file reads as empty: results then fall back to the fail-closed rules of the scan.
  }
  cache.set(file, { mtimeMs: s.mtimeMs, size: s.size, reviews })
  return reviews
}

/** Runs `fn` after every earlier write of this workspace's authority store. */
export function serialized<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const key = authorityDir(workspace)
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

/** Writes a JSON file of the authority store atomically (temp file + rename). */
export async function writeAuthorityFile(workspace: string, name: string, data: unknown): Promise<void> {
  const dir = authorityDir(workspace)
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** The recorded review of one application, or `undefined` when main never recorded one. */
export async function getReview(workspace: string, applicationId: string): Promise<RecordedReview | undefined> {
  const r = (await load(workspace))[applicationId]
  return r ? { ...r } : undefined
}

/**
 * Atomic read-modify-write of one application's review: `update` sees the current state and
 * returns the next one, or `null` to leave it (a compare-and-set when it checks what it saw).
 * Returns what is recorded afterwards and whether `update` wrote.
 */
export function updateReview(
  workspace: string,
  applicationId: string,
  update: (current: RecordedReview | undefined) => RecordedReview | null
): Promise<{ written: boolean; review: RecordedReview | undefined }> {
  return serialized(workspace, async () => {
    const reviews = { ...(await load(workspace)) }
    const current = reviews[applicationId]
    const next = update(current ? { ...current } : undefined)
    if (!next) return { written: false, review: current }
    reviews[applicationId] = next
    await writeAuthorityFile(workspace, REVIEWS_FILE, { version: 1, reviews })
    // Keep the cache on what was just written (a write within the same mtime tick and size must not read stale).
    const s = await stat(reviewsFile(workspace)).catch(() => null)
    if (s) cache.set(reviewsFile(workspace), { mtimeMs: s.mtimeMs, size: s.size, reviews })
    return { written: true, review: next }
  })
}

/** Same state, run and time: nothing was decided or re-run since `seen` was read. */
export function sameReview(a: Pick<ReviewTracking, 'state' | 'runId' | 'at'> | undefined, b: Pick<ReviewTracking, 'state' | 'runId' | 'at'> | undefined): boolean {
  if (!a || !b) return a === b
  return a.state === b.state && a.runId === b.runId && a.at === b.at
}

export const CONTINUED_REASON = 'Continued after review; not checked yet.'

/**
 * An unattended run is about to work on its result again (a Tailor reply, a Review re-run, a
 * nudge): whatever was approved no longer describes what will be on disk. Revokes the approval
 * (Unreviewed, new time, so every revision shown before is stale). A Discarded result stays
 * discarded: that decision is the user's and terminal.
 */
export async function reopenForContinuation(workspace: string, applicationId: string, runId: string, now: Date): Promise<void> {
  await updateReview(workspace, applicationId, (current) => {
    if (current?.state === 'discarded') return null
    // Already unreviewed for this run (a Review re-run recorded it with its own reason): nothing vouches for it.
    if (current?.state === 'unreviewed' && current.runId === runId) return null
    return { state: 'unreviewed', runId, at: now.toISOString(), reason: CONTINUED_REASON }
  })
}
