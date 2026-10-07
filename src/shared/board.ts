import type { ApplicationRecord, ApplicationStatus } from './applications-types'
import { jobIdFor, type Job } from './jobs-types'
import type { QueueItem } from './queue-types'

/**
 * The Board (#85): every job of the workspace as one card in a Kanban column, from a saved job
 * (To do) through tailoring and review to the application's status. Built in the renderer from
 * what `jobs.list()`, `queue.state()` and `applications.list()` already return; pure, for tests.
 */

export const BOARD_COLUMNS = [
  'todo',
  'tailoring',
  'review',
  'ready',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'archived'
] as const
export type BoardColumnId = (typeof BOARD_COLUMNS)[number]

export const BOARD_COLUMN_LABEL: Record<BoardColumnId, string> = {
  todo: 'To do',
  tailoring: 'Tailoring',
  review: 'Waiting for review',
  ready: 'Ready to apply',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  archived: 'Archived'
}

/** An archived card leaves the board this long after it was archived; the item itself stays on disk. */
export const ARCHIVE_TTL_DAYS = 7
const ARCHIVE_TTL_MS = ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000

interface CardBase {
  /** Unique on the board: `job:<id>`, `queue:<id>` or `app:<folder>`. */
  key: string
  column: BoardColumnId
  title: string
  subtitle: string
  /** ISO time the card last changed (newest first in a column); for Archived, when it was archived. */
  at: string
  /** Posting URL, when known. */
  url: string | null
}

export type BoardCard =
  | (CardBase & { kind: 'job'; job: Job })
  | (CardBase & { kind: 'queue'; item: QueueItem; job: Job | null })
  | (CardBase & { kind: 'application'; app: ApplicationRecord; job: Job | null })

export interface BoardColumn {
  id: BoardColumnId
  label: string
  cards: BoardCard[]
}

export interface Board {
  columns: BoardColumn[]
  /** Archived cards older than `ARCHIVE_TTL_DAYS`, left off the board. */
  hiddenArchived: number
}

export interface BoardInput {
  jobs: readonly Job[]
  applications: readonly ApplicationRecord[]
  queue: readonly QueueItem[]
  now?: Date
}

const STATUS_COLUMN: Record<ApplicationStatus, BoardColumnId> = {
  generated: 'ready',
  applied: 'applied',
  interviewing: 'interviewing',
  offer: 'offer',
  rejected: 'rejected',
  archived: 'archived'
}

/** Queue statuses that keep a card on Tailoring / Waiting for review; done and cancelled hand it back. */
const WORKING = new Set<QueueItem['status']>(['queued', 'preparing', 'running', 'needs-reply'])

/** Letters and digits only, lower case: `Tyrell Robotics` and the folder's `tyrell-robotics` compare equal. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The column an application's card belongs in, from its status and its unattended review state. */
export function applicationColumn(app: ApplicationRecord): BoardColumnId {
  const { status, review } = app.tracking
  if (status !== 'generated') return STATUS_COLUMN[status]
  if (review?.state === 'discarded') return 'archived'
  if (review?.state === 'unreviewed' || review?.state === 'needs-attention') return 'review'
  return 'ready'
}

/** When an archived card was archived; items archived before #85 have no time and fall back to their last change. */
function archivedAt(card: BoardCard): string {
  if (card.kind === 'job') return card.job.dismissedAt ?? card.job.fetchedAt
  if (card.kind === 'application') {
    const t = card.app.tracking
    if (t.status === 'archived') return t.archivedAt ?? card.app.updatedAt
    return t.review?.reviewedAt ?? t.review?.at ?? card.app.updatedAt
  }
  return card.at
}

function jobCard(job: Job): BoardCard {
  return {
    kind: 'job',
    key: `job:${job.id}`,
    column: job.dismissed ? 'archived' : 'todo',
    title: job.title,
    subtitle: [job.company, job.location].filter(Boolean).join(' · '),
    at: job.fetchedAt,
    url: job.url || null,
    job
  }
}

function queueCard(item: QueueItem, job: Job | null): BoardCard {
  const [title, company] = item.title.split(' · ')
  return {
    kind: 'queue',
    key: `queue:${item.id}`,
    column: item.status === 'needs-reply' ? 'review' : 'tailoring',
    title: job?.title ?? title,
    subtitle: job ? [job.company, job.location].filter(Boolean).join(' · ') : (company ?? ''),
    at: item.updatedAt,
    url: job?.url || null,
    item,
    job
  }
}

function applicationCard(app: ApplicationRecord, job: Job | null): BoardCard {
  return {
    kind: 'application',
    key: `app:${app.id}`,
    column: applicationColumn(app),
    title: app.jobTitle || app.role,
    subtitle: app.company,
    at: app.updatedAt,
    url: app.jobUrl,
    app,
    job
  }
}

/**
 * Every job as one card. Per job, the card of the furthest stage wins: an application past
 * `generated`, then a working queue item, then a `generated` application, then a failed queue
 * item, then the saved job itself. A saved job is matched to its application by posting URL, or by
 * the folder's job id together with the company; to a queue item by its id or an alias.
 */
export function buildBoard({ jobs, applications, queue, now = new Date() }: BoardInput): Board {
  const jobOf = new Map<string, Job>()
  for (const j of jobs) for (const id of [j.id, ...(j.aliases ?? [])]) jobOf.set(id, j)

  const appOf = new Map<Job, ApplicationRecord>()
  const claimed = new Set<ApplicationRecord>()
  for (const job of jobs) {
    const app =
      applications.find((a) => !claimed.has(a) && !!job.url && a.jobUrl === job.url) ??
      applications.find(
        (a) => !claimed.has(a) && a.jobId === jobIdFor(job) && !!job.company && norm(a.company) === norm(job.company)
      )
    if (app) {
      appOf.set(job, app)
      claimed.add(app)
    }
  }

  // The latest queue item per job (or per title for a job no longer saved).
  const itemOf = new Map<Job | string, QueueItem>()
  for (const item of queue) {
    if (!WORKING.has(item.status) && item.status !== 'failed') continue
    const owner = jobOf.get(item.jobId) ?? `id:${item.jobId}`
    const cur = itemOf.get(owner)
    const rank = (i: QueueItem) => (WORKING.has(i.status) ? 1 : 0)
    if (!cur || rank(item) > rank(cur) || (rank(item) === rank(cur) && item.updatedAt > cur.updatedAt)) {
      itemOf.set(owner, item)
    }
  }

  const cards: BoardCard[] = []
  for (const job of jobs) {
    const app = appOf.get(job)
    const item = itemOf.get(job)
    const working = item && WORKING.has(item.status)
    if (app && (app.tracking.status !== 'generated' || !working)) cards.push(applicationCard(app, job))
    else if (item) cards.push(queueCard(item, job))
    else cards.push(jobCard(job))
  }
  for (const app of applications) if (!claimed.has(app)) cards.push(applicationCard(app, null))
  for (const [owner, item] of itemOf) if (typeof owner === 'string') cards.push(queueCard(item, null))

  const cutoff = now.getTime() - ARCHIVE_TTL_MS
  let hiddenArchived = 0
  const columns = BOARD_COLUMNS.map((id): BoardColumn => ({ id, label: BOARD_COLUMN_LABEL[id], cards: [] }))
  for (const card of cards) {
    if (card.column === 'archived') {
      const at = archivedAt(card)
      if (Date.parse(at) <= cutoff) {
        hiddenArchived++
        continue
      }
      card.at = at
    }
    columns[BOARD_COLUMNS.indexOf(card.column)].cards.push(card)
  }
  for (const c of columns) c.cards.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
  return { columns, hiddenArchived }
}

/** What a move writes: an application's new status, or a saved job's dismissed flag. */
export type BoardMove =
  | { kind: 'application'; id: string; patch: { status: ApplicationStatus } }
  | { kind: 'job'; id: string; patch: { dismissed: boolean } }

const COLUMN_STATUS: Partial<Record<BoardColumnId, ApplicationStatus>> = {
  ready: 'generated',
  applied: 'applied',
  interviewing: 'interviewing',
  offer: 'offer',
  rejected: 'rejected',
  archived: 'archived'
}

/**
 * The write behind dropping `card` on column `to`, or `null` when the move means nothing.
 * Tailoring and Waiting for review are run by the queue and the Review page and take no drops;
 * a queue card cannot be moved; a result discarded on Review stays where it is; a result still
 * waiting for review can only be archived or rejected.
 */
export function moveFor(card: BoardCard, to: BoardColumnId): BoardMove | null {
  if (to === card.column) return null
  if (card.kind === 'job') {
    if (card.column === 'todo' && to === 'archived') return { kind: 'job', id: card.job.id, patch: { dismissed: true } }
    if (card.column === 'archived' && to === 'todo') return { kind: 'job', id: card.job.id, patch: { dismissed: false } }
    return null
  }
  if (card.kind === 'queue') return null
  if (card.app.tracking.review?.state === 'discarded') return null
  const status = COLUMN_STATUS[to]
  if (!status) return null
  if (card.column === 'review' && to !== 'archived' && to !== 'rejected') return null
  return { kind: 'application', id: card.app.id, patch: { status } }
}

/** Columns `card` may be moved to, in board order. */
export function moveTargets(card: BoardCard): BoardColumnId[] {
  return BOARD_COLUMNS.filter((c) => moveFor(card, c) !== null)
}
