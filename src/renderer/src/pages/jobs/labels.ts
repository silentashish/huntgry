import { seniorityOf, sponsorshipOf, workplaceOf } from '@shared/job-filters'
import type { JobScore } from '@shared/job-relevance'
import type { Job, JobSourceId } from '@shared/jobs-types'
import type { QueueItemStatus } from '@shared/queue-types'
import { scoreLabel, scoreTone, type UiTone } from '../../components/ui'

/**
 * How a Scent score reads on a row and in the drawer. A job Relevant leaves out (dismissed, or "no
 * sponsorship" for a profile that needs it) keeps its number but loses the colour, and says why.
 */
export function scentDisplay(score: JobScore): { tone: UiTone; label: string; excluded: string | null } {
  if (score.excluded) return { tone: 'neutral', label: 'Left out of Relevant', excluded: score.excluded }
  return { tone: scoreTone(score.score), label: scoreLabel(score.score), excluded: null }
}

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
