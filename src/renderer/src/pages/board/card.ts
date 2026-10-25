import type { BoardCard, BoardColumnId } from '@shared/board'
import { sponsorshipOf, workplaceOf } from '@shared/job-filters'
import { hasRelevanceSignals, scoreJob, type ProfileSignals } from '@shared/job-relevance'
import { REVIEW_STATE_LABEL, type ReviewState } from '@shared/review-types'
import { AGENT_LABEL, type AgentId } from '@shared/runner-types'
import type { QueueItemStatus } from '@shared/queue-types'
import type { UiTone } from '../../components/ui'
import { QUEUE_STATUS_LABEL } from '../tailor/status'

/**
 * What a Board card shows (#110), worked out from the card alone so it can be tested without
 * rendering: the Scent ring, the status pills and the mono meta line.
 */

/** The dot before each column's name (Figma Board lanes). */
export const COLUMN_TONE: Record<BoardColumnId, UiTone> = {
  todo: 'neutral',
  tailoring: 'info',
  review: 'warning',
  submit: 'trail',
  ready: 'accent',
  applied: 'info',
  interviewing: 'review',
  offer: 'success',
  rejected: 'danger',
  archived: 'neutral'
}

/**
 * The Scent ring of a card: the job's relevance score (already 0–100, `scoreJob`) when the card
 * knows its saved job and the master profile has something to match on; otherwise a check for
 * work already tailored, or the company's initial.
 */
export type Scent =
  | { mode: 'score'; value: number; reasons: string[] }
  | { mode: 'done' }
  | { mode: 'initial'; letter: string }

export function cardScent(card: BoardCard, signals: ProfileSignals | null, now = new Date()): Scent {
  const job = card.job
  if (job && signals && hasRelevanceSignals(signals)) {
    const { score, reasons } = scoreJob(job, signals, now)
    return { mode: 'score', value: score, reasons }
  }
  if (card.kind === 'application' || job?.tailoredAt) return { mode: 'done' }
  const name = companyOf(card) || card.title
  const letter = Array.from(name.replace(/[^\p{L}\p{N}]/gu, ''))[0]
  return { mode: 'initial', letter: letter ? letter.toUpperCase() : '?' }
}

/** The company behind a card, for its avatar. */
export function companyOf(card: BoardCard): string {
  if (card.kind === 'application') return card.app.company
  if (card.kind === 'job') return card.job.company
  return card.job?.company ?? card.item.title.split(' · ')[1] ?? ''
}

export interface Pill {
  label: string
  tone: UiTone
  variant: 'soft' | 'outline'
  dot?: boolean
  /** Hover text with the detail behind the pill. */
  title?: string
}

const QUEUE_TONE: Record<QueueItemStatus, UiTone> = {
  queued: 'neutral',
  preparing: 'trail',
  running: 'info',
  'needs-reply': 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral'
}

const AGENT_TONE: Record<AgentId, UiTone> = { claude: 'accent', codex: 'trail', antigravity: 'info' }

const REVIEW_TONE: Record<ReviewState, UiTone> = {
  unreviewed: 'warning',
  'needs-attention': 'accent',
  approved: 'success',
  discarded: 'neutral'
}

/** Status pills, left to right. */
export function cardPills(card: BoardCard): Pill[] {
  if (card.kind === 'job') {
    const j = card.job
    const pills: Pill[] = []
    const place = workplaceOf(j)
    if (place) pills.push({ label: place, tone: place === 'Remote' ? 'trail' : 'neutral', variant: 'soft' })
    const sponsors = sponsorshipOf(j)
    if (sponsors === true) pills.push({ label: 'Sponsors visa', tone: 'review', variant: 'soft' })
    if (sponsors === false) pills.push({ label: 'No sponsorship', tone: 'warning', variant: 'soft' })
    if (j.tailoredAt) pills.push({ label: 'Tailored', tone: 'success', variant: 'soft' })
    return pills
  }
  if (card.kind === 'queue') {
    const { status, agent, unattended, error } = card.item
    const live = status === 'running' || status === 'preparing' || status === 'needs-reply'
    const pills: Pill[] = [
      { label: QUEUE_STATUS_LABEL[status].label, tone: QUEUE_TONE[status], variant: 'soft', dot: live, title: error }
    ]
    pills.push({ label: AGENT_LABEL[agent] ?? agent, tone: AGENT_TONE[agent] ?? 'neutral', variant: 'outline' })
    if (unattended) pills.push({ label: 'Unattended', tone: 'neutral', variant: 'outline' })
    return pills
  }
  const { app } = card
  const pills: Pill[] = []
  const review = app.tracking.review
  if (review) {
    pills.push({ label: REVIEW_STATE_LABEL[review.state].label, tone: REVIEW_TONE[review.state], variant: 'outline', title: review.reason })
  }
  const b = app.build
  if (b.status === 'pass') {
    const warnings = b.warnings > 0 ? `${b.warnings} warning${b.warnings === 1 ? '' : 's'}` : 'All checks passed'
    pills.push({ label: 'ATS passed', tone: 'success', variant: 'soft', title: warnings })
  } else if (b.status === 'unknown') {
    pills.push({ label: 'No report', tone: 'neutral', variant: 'soft', title: 'build-report.json is missing or unreadable' })
  } else {
    pills.push({ label: 'Build failed', tone: 'danger', variant: 'soft', title: b.failed.join(', ') || 'The build did not pass' })
  }
  if (app.tracking.appliedAt) pills.push({ label: `applied ${app.tracking.appliedAt}`, tone: 'neutral', variant: 'soft' })
  return pills
}

const MINUTE = 60_000
const DAY = 86_400_000

/** "today", "yesterday", "3 days ago", "2 months ago". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const days = Math.floor((now - t) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  return `${Math.floor(days / 30)} months ago`
}

/** A short span: "<1 min", "14 min", "3 h", "2 days". */
export function span(ms: number): string {
  const min = Math.max(0, Math.floor(ms / MINUTE))
  if (min < 1) return '<1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} days`
}

/** The mono line at the bottom of a card: when, how long, or which files. */
export function cardMeta(card: BoardCard, now = Date.now()): string {
  if (card.column === 'archived') return `archived ${ago(card.at, now)}`
  if (card.kind === 'job') return ago(card.job.postedAt ?? card.job.fetchedAt, now)
  if (card.kind === 'queue') {
    const { status, notBefore, updatedAt } = card.item
    const since = now - Date.parse(updatedAt)
    if (status === 'queued') {
      const wait = notBefore ? Date.parse(notBefore) - now : NaN
      return wait > 0 ? `starts in ${span(wait)}` : 'queued'
    }
    if (status === 'needs-reply') return `waiting ${span(since)}`
    if (status === 'failed') return `failed ${ago(updatedAt, now)}`
    return `working ${span(since)}`
  }
  const t = card.app.tracking
  if (card.column === 'review') return t.review ? 'unattended' : pdfs(card.app.files)
  if (card.column === 'ready') return pdfs(card.app.files)
  if (card.column === 'submit') return 'form filled · not submitted'
  if (card.column === 'applied' && t.appliedAt) {
    const days = Math.floor((now - Date.parse(t.appliedAt)) / DAY)
    return Number.isFinite(days) ? (days <= 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`) : ''
  }
  return ago(card.at, now)
}

const pdfs = (files: readonly string[]) => ['resume.pdf', 'cover.pdf'].filter((f) => files.includes(f)).join(' · ')
