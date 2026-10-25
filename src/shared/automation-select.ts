import type { ApplicationRecord } from './applications-types'
import {
  PER_COMPANY_DAYS,
  SETTLED_STEPS,
  WORKING_STEPS,
  type AutomationCandidate,
  type AutomationMatch,
  type AutomationSettings
} from './automation-types'
import { matchesFilters, type JobFilters } from './job-filters'
import { scoreJob, type ProfileSignals } from './job-relevance'
import { jobIdFor, type Job } from './jobs-types'
import type { MatchResult } from './match-score'

/**
 * Automation's candidate selection (#154), pure: which jobs a run picks, in what order, and why each other
 * one is skipped. A candidate must pass Relevant's rules (not dismissed, not "does not sponsor" for someone who
 * needs it, title or skills in common), the user's saved Jobs filters, and, when it can be scored now, the
 * match score's threshold, minimum requirements and gates (#149). Explore rows have no description yet: they
 * pass on the title and Relevant rules, and the service scores them once their posting is read. Caps: at most
 * `perCompany` per company (ready, in flight, applied in the last 30 days) and `perDay` jobs entering tailoring
 * per local day.
 */

/** One job a candidate source offers (`src/main/automation/sources.ts`). */
export interface CandidateInput {
  /** Stable key: the saved job id, or `explore:<row id>` for a row not saved yet. */
  key: string
  source: AutomationCandidate['source']
  /** What selection reads (an Explore row as the Job it would be saved as). */
  job: Job
  /** The saved job, when there is one. */
  savedJobId?: string
  /** The job has a description to score without loading anything. */
  scoreable: boolean
}

export interface SelectContext {
  signals: ProfileSignals
  filters: JobFilters
  applications: readonly Pick<ApplicationRecord, 'id' | 'jobId' | 'company' | 'createdAt' | 'jobUrl' | 'tracking'>[]
  /** Automation's own record of every candidate it has seen. */
  candidates: Readonly<Record<string, AutomationCandidate>>
  day: { date: string; started: number }
  settings: AutomationSettings
  now: Date
  /** Local YYYY-MM-DD of `now`. */
  today: string
}

export interface Selection {
  /** In run order. */
  picked: AutomationCandidate[]
  skipped: AutomationCandidate[]
}

/** Letters and digits only, lower case: `Tyrell Robotics` and `tyrell-robotics` are one company. */
export const normCompany = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

const DAY_MS = 86_400_000

export function matchOf(m: MatchResult): AutomationMatch {
  return {
    score: m.score,
    requirements: m.matched.length + m.missing.length,
    matched: m.matched.map((s) => s.skill),
    missing: m.missing.map((s) => s.skill),
    gates: m.gates,
    source: m.source
  }
}

/** Why a scored job is not picked, or `null` when it passes threshold, requirements and gates. */
export function matchSkipReason(match: AutomationMatch, settings: Pick<AutomationSettings, 'threshold' | 'minRequirements'>): string | null {
  if (match.requirements === 0) return 'Match unknown: the posting names no requirements Huntgry can read.'
  if (match.gates.length > 0) return match.gates.map((g) => g.reason).join(' · ')
  if (match.requirements < settings.minRequirements)
    return `Names only ${match.requirements} requirement${match.requirements === 1 ? '' : 's'} (fewer than ${settings.minRequirements}).`
  if (match.score < settings.threshold) return `Match ${match.score}, below ${settings.threshold}.`
  return null
}

export function matchReason(match: AutomationMatch): string {
  return `Match ${match.score} · ${match.requirements} requirements`
}

/** The application a job already has: by posting URL, or by job id with the same company (like the Board). */
function applicationOf(job: Job, applications: SelectContext['applications']): SelectContext['applications'][number] | undefined {
  return (
    applications.find((a) => !!job.url && a.jobUrl === job.url) ??
    applications.find((a) => a.jobId === jobIdFor(job) && !!job.company && normCompany(a.company) === normCompany(job.company))
  )
}

/** The candidate record of a job: by its key, or by its saved job id (an Explore row saved since). */
function priorOf(input: CandidateInput, candidates: SelectContext['candidates']): AutomationCandidate | undefined {
  return candidates[input.key] ?? (input.savedJobId ? candidates[input.savedJobId] : undefined)
}

/** One per job: a saved job wins over the Explore row it was saved from; the same title at the same company counts once. */
function dedupe(inputs: readonly CandidateInput[]): CandidateInput[] {
  const seen = new Set<string>()
  const out: CandidateInput[] = []
  for (const input of inputs) {
    const ids = [input.savedJobId ?? input.job.id, ...(input.job.aliases ?? []), `t:${normCompany(input.job.company)}|${normCompany(input.job.title)}`]
    if (ids.some((id) => seen.has(id))) continue
    for (const id of ids) seen.add(id)
    out.push(input)
  }
  return out
}

/**
 * Picks the run's candidates. `inputs` come from the sources in order (saved Jobs first). Jobs Automation
 * already settled (Ready to submit, Submitted, Needs you), is working on, or skipped for good after reading the
 * full posting are left out of both lists: the page shows them where they are.
 */
export function selectCandidates(inputs: readonly CandidateInput[], ctx: SelectContext): Selection {
  const { settings, now } = ctx
  const at = now.toISOString()
  const skipped: AutomationCandidate[] = []
  const scored: Array<{ c: AutomationCandidate; rank: number; posted: number }> = []
  const unscored: Array<{ c: AutomationCandidate; rank: number; posted: number }> = []

  for (const input of dedupe(inputs)) {
    const prior = priorOf(input, ctx.candidates)
    if (prior && (SETTLED_STEPS.has(prior.step) || WORKING_STEPS.has(prior.step) || (prior.step === 'skipped' && prior.final))) continue
    const job = input.job
    const base: AutomationCandidate = {
      key: prior?.key ?? input.key,
      source: input.source,
      ...(input.savedJobId ? { jobId: input.savedJobId } : {}),
      title: job.title,
      company: job.company,
      ...(job.postedAt ? { postedAt: job.postedAt } : {}),
      reasons: [],
      step: 'selected',
      updatedAt: at
    }
    const skip = (reason: string, match?: AutomationMatch) =>
      skipped.push({ ...base, step: 'skipped', reasons: [reason], ...(match ? { match } : {}) })

    if (job.dismissed) {
      skip('Dismissed.')
      continue
    }
    const app = applicationOf(job, ctx.applications)
    if (app && app.tracking.status !== 'generated') {
      skip(`Already ${app.tracking.status}.`)
      continue
    }
    if (app || job.tailoredAt) {
      skip('Tailored before.')
      continue
    }
    const score = scoreJob(job, ctx.signals, now)
    const match = input.scoreable ? matchOf(score.match) : undefined
    if (score.excluded) {
      skip(`${score.excluded}.`, match)
      continue
    }
    if (!score.matched) {
      skip('No title or skill in common with your profile.', match)
      continue
    }
    if (!matchesFilters(job, ctx.filters, now)) {
      skip('Hidden by your Jobs filters.', match)
      continue
    }
    const posted = job.postedAt ? Date.parse(job.postedAt) || 0 : 0
    if (match) {
      const why = matchSkipReason(match, settings)
      if (why) {
        skip(why, match)
        continue
      }
      scored.push({ c: { ...base, match, reasons: [matchReason(match), ...score.reasons] }, rank: match.score, posted })
    } else {
      unscored.push({ c: { ...base, reasons: ['Scored once its posting is read.', ...score.reasons] }, rank: score.score, posted })
    }
  }

  const byRank = (a: { rank: number; posted: number }, b: { rank: number; posted: number }) => b.rank - a.rank || b.posted - a.posted
  const ordered = [...scored.sort(byRank), ...unscored.sort(byRank)]

  // Per company: what Automation has ready or in flight, and applications made in the last 30 days.
  const held = new Map<string, Set<string>>()
  const hold = (company: string, id: string) => {
    const k = normCompany(company)
    if (!k) return
    if (!held.has(k)) held.set(k, new Set())
    held.get(k)!.add(id)
  }
  const since = now.getTime() - PER_COMPANY_DAYS * DAY_MS
  for (const a of ctx.applications) {
    const created = Date.parse(a.createdAt)
    if (Number.isFinite(created) && created >= since) hold(a.company, `app:${a.id}`)
  }
  for (const c of Object.values(ctx.candidates)) {
    if (c.step === 'ready' || c.step === 'submitted' || WORKING_STEPS.has(c.step)) hold(c.company, c.applicationId ? `app:${c.applicationId}` : `key:${c.key}`)
  }

  // Per day: only jobs that will be tailored for sure (scored now) count here; Explore rows are counted when they
  // reach tailoring (the service checks the cap again there).
  const startedToday = ctx.day.date === ctx.today ? ctx.day.started : 0
  let dayLeft = Math.max(0, settings.perDay - startedToday)
  const picked: AutomationCandidate[] = []
  for (const { c } of ordered) {
    const company = normCompany(c.company)
    if (company && (held.get(company)?.size ?? 0) >= settings.perCompany) {
      skipped.push({ ...c, step: 'skipped', reasons: [`Cap: ${settings.perCompany} per company.`, ...c.reasons] })
      continue
    }
    if (c.match && dayLeft <= 0) {
      skipped.push({ ...c, step: 'skipped', reasons: [`Cap: ${settings.perDay} a day.`, ...c.reasons] })
      continue
    }
    if (c.match) dayLeft--
    hold(c.company, `key:${c.key}`)
    picked.push(c)
  }
  return { picked, skipped }
}

/** Local YYYY-MM-DD of `date`. */
export function localDay(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}
