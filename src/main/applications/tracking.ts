import { randomBytes } from 'node:crypto'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APPLICATION_STATUSES,
  DEFAULT_TRACKING,
  type ApplicationStatus,
  type ApplicationTracking
} from '@shared/applications-types'
import type { ReviewTracking } from '@shared/review-types'

/**
 * `<job folder>/huntgry.json`: Huntgry's tracking data for one application.
 * Created lazily, written atomically, never touching the skill's own files.
 */

export const TRACKING_FILE = 'huntgry.json'

const isStatus = (v: unknown): v is ApplicationStatus => APPLICATION_STATUSES.includes(v as ApplicationStatus)
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Keeps only known, well-typed fields; anything else in the file is dropped on the next write. */
export function normalizeTracking(input: unknown): ApplicationTracking {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const t: ApplicationTracking = {
    status: isStatus(o.status) ? o.status : DEFAULT_TRACKING.status,
    notes: typeof o.notes === 'string' ? o.notes.slice(0, 20_000) : ''
  }
  if (typeof o.appliedAt === 'string' && DATE.test(o.appliedAt)) t.appliedAt = o.appliedAt
  if (typeof o.jobUrl === 'string' && /^https?:\/\//i.test(o.jobUrl)) t.jobUrl = o.jobUrl.slice(0, 2000)
  if (typeof o.source === 'string' && o.source.trim()) t.source = o.source.trim().slice(0, 50)
  const review = normalizeReview(o.review)
  if (review) t.review = review
  return t
}

const REVIEW_STATES = ['unreviewed', 'needs-attention', 'approved', 'discarded'] as const

export const UNREADABLE_REVIEW = 'The review state in huntgry.json is unreadable: check this result on the Review page.'

/**
 * `review` as written by the pipeline and the Review page. A malformed one fails closed: it
 * reads as Needs attention, so a damaged file never lets an unattended result reach Apply.
 */
export function normalizeReview(input: unknown): ReviewTracking | undefined {
  if (input === undefined || input === null) return undefined
  const unreadable: ReviewTracking = { state: 'needs-attention', runId: '', at: '', reason: UNREADABLE_REVIEW }
  if (typeof input !== 'object') return unreadable
  const r = input as Record<string, unknown>
  if (!(REVIEW_STATES as readonly unknown[]).includes(r.state)) return unreadable
  if (typeof r.runId !== 'string' || typeof r.at !== 'string') return unreadable
  const out: ReviewTracking = { state: r.state as ReviewTracking['state'], runId: r.runId, at: r.at }
  if (typeof r.reason === 'string' && r.reason) out.reason = r.reason.slice(0, 2000)
  if (typeof r.reviewedAt === 'string') out.reviewedAt = r.reviewedAt
  if (typeof r.via === 'string' && /^(desktop|phone:[\w-]{1,100})$/.test(r.via)) out.via = r.via as ReviewTracking['via']
  return out
}

/** Tracking for a folder; defaults when `huntgry.json` is missing, unreadable or not a regular file. */
export async function readTracking(folder: string): Promise<ApplicationTracking> {
  try {
    const path = join(folder, TRACKING_FILE)
    if (!(await lstat(path)).isFile()) return { ...DEFAULT_TRACKING }
    return normalizeTracking(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return { ...DEFAULT_TRACKING }
  }
}

/**
 * Merges `patch` into the folder's tracking and writes it atomically.
 * `appliedAt` is set to today the first time the status becomes `applied`.
 * Empty strings clear optional fields.
 */
export function updateTracking(
  folder: string,
  patch: Partial<ApplicationTracking>,
  today = new Date()
): Promise<ApplicationTracking> {
  // One read-merge-write at a time per folder, so quick successive edits cannot overwrite each other.
  const previous = locks.get(folder) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => writeMerged(folder, patch, today))
  const tail = run.catch(() => undefined)
  locks.set(folder, tail)
  void tail.then(() => {
    if (locks.get(folder) === tail) locks.delete(folder)
  })
  return run
}

const locks = new Map<string, Promise<unknown>>()

async function writeMerged(
  folder: string,
  patch: Partial<ApplicationTracking>,
  today: Date
): Promise<ApplicationTracking> {
  const current = await readTracking(folder)
  const merged: Record<string, unknown> = { ...current, ...patch }
  for (const k of ['appliedAt', 'jobUrl', 'source'] as const) if (merged[k] === '') delete merged[k]
  const next = normalizeTracking(merged)
  if (next.status === 'applied' && !next.appliedAt && patch.appliedAt === undefined) {
    next.appliedAt = today.toISOString().slice(0, 10)
  }
  const tmp = join(folder, `.${TRACKING_FILE}.${randomBytes(4).toString('hex')}.tmp`)
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, join(folder, TRACKING_FILE))
  return next
}

/**
 * For other features (Jobs board, Claude runner): remember where an
 * application's job came from without disturbing its status or notes.
 */
export async function recordJobSource(folder: string, jobUrl: string, source: string): Promise<ApplicationTracking> {
  return updateTracking(folder, { jobUrl, source })
}
