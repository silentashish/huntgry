import { seniorityOf, sponsorshipOf, workplaceOf } from '@shared/job-filters'
import type { Job, JobSourceId } from '@shared/jobs-types'
import type { QueueItemStatus } from '@shared/queue-types'
import type { RowScore } from '@shared/explore-score'
import { scoreLabel, scoreTone, type UiTone } from '../../components/ui'

/**
 * How a match score (#149) reads in the drawer and on a Board card (#189: the one score of a job): "Strong match" and
 * its tone, or a neutral "Title-only estimate" for a job with no description to match (#150).
 */
export function matchDisplay(match: RowScore): { tone: UiTone; label: string } {
  if (match.kind === 'estimate') return { tone: 'neutral', label: 'Title-only estimate' }
  return { tone: scoreTone(match.score), label: scoreLabel(match.score) }
}

/** What a match score is made of, one line each: the skills the profile has and lacks, and the failed gates. */
export function matchNotes(match: RowScore): string[] {
  if (match.kind === 'estimate') return ['No qualifications to match: scored on title, seniority and location', ...match.reasons]
  const names = (skills: readonly { skill: string }[]) => skills.map((s) => s.skill).join(', ')
  return [
    ...(match.matched.length > 0 ? [`You have: ${names(match.matched)}`] : []),
    ...(match.missing.length > 0 ? [`Missing: ${names(match.missing)}`] : []),
    ...(match.matched.length === 0 && match.missing.length === 0 ? ['The posting names no skill Huntgry can read.'] : []),
    ...match.gates.map((g) => `✕ ${g.reason}`)
  ]
}

/** What a row and the drawer say before why Relevant leaves a job out (dismissed, or "no sponsorship" when needed). */
export const RELEVANT_LEFT_OUT = 'Left out of Relevant'

export const SOURCE_LABEL: Record<JobSourceId, string> = {
  'hiring.cafe': 'hiring.cafe',
  indeed: 'Indeed',
  url: 'Added by URL',
  pasted: 'Pasted',
  jobright: 'Jobright'
}

/** "3 days ago" style age of a posting. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? '1 month ago' : `${months} months ago`
}

/** "Stripe · Remote (US) · $185k – $240k": company, location and pay, whichever are known. */
export function jobMeta(job: Pick<Job, 'company' | 'location' | 'salary'>): string {
  return [job.company, job.location, job.salary].filter(Boolean).join(' · ')
}

/** A status pill: its text and tone. */
export interface Pill {
  label: string
  tone: UiTone
}

/** The workplace pill of a row: Remote in Trail, Hybrid and Onsite neutral; `null` when unknown. */
export function workplacePill(job: Pick<Job, 'workplaceType' | 'remote'>): Pill | null {
  const w = workplaceOf(job)
  if (!w) return null
  return { label: w, tone: w === 'Remote' ? 'trail' : 'neutral' }
}

/** What the posting says about visa sponsorship, as a pill; `null` when it does not say. */
export function sponsorshipPill(job: Pick<Job, 'visaSponsorship' | 'description'>): Pill | null {
  const s = sponsorshipOf(job)
  if (s === true) return { label: 'Sponsors visa', tone: 'review' }
  if (s === false) return { label: 'No sponsorship', tone: 'warning' }
  return null
}

/** Tone of each queue state on a job row (the Tailor queue's colours). */
export const QUEUE_STATUS_TONE: Record<QueueItemStatus, UiTone> = {
  queued: 'neutral',
  preparing: 'trail',
  running: 'info',
  'needs-reply': 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral'
}

/** Queue states that are live: their pill gets a dot. */
export const LIVE_QUEUE_STATUSES: readonly QueueItemStatus[] = ['preparing', 'running', 'needs-reply']

/** The facts the board or the posting gave, for the job drawer's tiles. Unknown facts are left out. */
export function jobFacts(job: Job): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = []
  const seniority = seniorityOf(job)
  if (seniority) facts.push({ label: 'Seniority', value: seniority.replace(/ Level$/, '') })
  const workplace = workplaceOf(job)
  if (workplace) facts.push({ label: 'Workplace', value: workplace })
  const visa = sponsorshipOf(job)
  if (visa !== null) facts.push({ label: 'Visa', value: visa ? 'Sponsors' : 'No sponsorship' })
  if (typeof job.minYearsExperience === 'number') {
    const n = job.minYearsExperience
    facts.push({ label: 'Min. exp', value: `${n} year${n === 1 ? '' : 's'}` })
  }
  if (job.commitment?.length) facts.push({ label: 'Commitment', value: job.commitment.join(', ') })
  if (job.salary) facts.push({ label: 'Salary', value: job.salary })
  return facts
}
