import { matchesLocation, seniorityOf, sponsorshipOf } from './job-filters'
import type { Job } from './jobs-types'
import { buildKnowledgeGraph, interval, mergedYears } from './knowledge-graph'
import type { MasterProfile } from './master-profile'
import { matchScore, type MatchProfile, type MatchResult, type ProfileDegree } from './match-score'

/**
 * "Relevant" jobs (#73): how well a saved job fits the master profile, scored
 * locally and deterministically (no model call). The profile gives target
 * titles, skills, a location, years of experience and whether a visa is
 * needed; a job scores on title, skills, seniority, location and recency. The skills part is the job's
 * match score (#149, `match-score.ts`): how much of what the job asks for the profile has.
 */

export { sponsorshipFromText } from './job-filters'

/** What the profile says, for Relevant and for the match score (`MatchProfile`). */
export interface ProfileSignals extends MatchProfile {
  /** Short target titles: the headline, then the two most recent roles. */
  titles: string[]
  /** Skill names the profile has evidence for (knowledge graph, gaps excluded). */
  skills: string[]
  location: string
  /** The profile's location is "Remote". */
  remote: boolean
  needsSponsorship: boolean
  /** Years of experience, overlaps counted once. */
  years: number
  /** The Education section's degrees, for the match score's degree gates. */
  degrees?: ProfileDegree[]
  /** The profile's own words without its gaps, for the match score's evidence (`MatchProfile.evidence`). */
  evidence?: string
}

/** Score out of 100 and when a job is relevant. */
export const RELEVANCE_THRESHOLD = 40

/** The skills part is `skills × match score / 100`. */
const WEIGHT = { title: 35, skills: 35, seniority: 10, location: 10, recency: 10 }

/** A headline as a search title: "Full-Stack Software Engineer | AI" → "Full-Stack Software Engineer". */
export function shortTitle(text: string): string {
  const first = text.split(/\s[|·•–—/]\s|[|·•(]|,\s|\s-\s/)[0] ?? ''
  return first.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** A clause that says no visa is needed: a citizen, a green card, "no sponsorship needed", "authorized … without". */
const NO_NEED =
  /\b(?:no|not|without|never|don'?t|doesn'?t|won'?t)\b.{0,30}\b(?:sponsor\w*|visa)\b|\bsponsorship\b.{0,15}\bnot\b|\bcitizen|\bgreen\s*card\b|\bpermanent\s+resident|\bauthori[sz]ed\b.{0,40}\bwithout\b/i
/** A clause that says a sponsor is needed: "needs H-1B sponsorship", "will require a visa", "sponsorship required". */
const EXPLICIT_NEED =
  /\b(?:need|needs|needing|require|requires|requiring)\b.{0,30}\b(?:sponsor\w*|h-?1b|visa)\b|\bsponsorship\s+(?:is\s+)?(?:needed|required)\b/i
/** A clause that only mentions a visa status: H-1B, F-1, OPT, CPT, TN, L-1, O-1, H-4. */
const NEED = /sponsor|\bh-?1b\b|\bvisa\b|\b(?:stem\s+)?opt\b|\bf-?1\b|\bcpt\b|\bh-?4\b|\bl-?1\b|\bo-?1\b|\btn\b/i

/**
 * Whether work-authorization text says the person needs a visa sponsor:
 * "needs H-1B sponsorship", "F-1 OPT, will need sponsorship", "STEM OPT" → `true`;
 * "US citizen", "Green card holder, no sponsorship needed", "H-4 EAD, no sponsorship needed" → `false`.
 * Read clause by clause: an explicit need wins ("Not a US citizen, needs sponsorship"), then an
 * explicit "no sponsorship needed", and only then a bare visa status counts as a need.
 */
export function needsSponsorshipFrom(text: string): boolean {
  const clauses = text
    .split(/[.;,\n]|\s\band\b\s/i)
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.some((c) => !NO_NEED.test(c) && EXPLICIT_NEED.test(c))) return true
  if (clauses.some((c) => NO_NEED.test(c))) return false
  return clauses.some((c) => NEED.test(c))
}

/** The profile's words that count as evidence of a skill: everything but contact details and "Gaps & notes". */
function evidenceText(p: MasterProfile): string {
  return [
    ...p.skills.flatMap((g) => g.items),
    p.summary,
    ...p.experience.flatMap((e) => [e.role, e.project, e.technologies, ...e.highlights]),
    ...p.projects.flatMap((x) => [x.name, x.technologies, x.description, ...x.highlights]),
    ...p.education.flatMap((e) => [e.field, ...e.highlights]),
    ...p.certifications.map((c) => c.name),
    ...p.publications.flatMap((x) => [x.title, x.description])
  ]
    .filter((t) => t && t.trim())
    .join('\n')
}

export function profileSignals(profile: MasterProfile, now = new Date()): ProfileSignals {
  const dated = profile.experience
    .map((e, i) => ({ e, i, span: interval(e.start, e.end, now) }))
    // Most recent first; undated entries keep their order after the dated ones.
    .sort((a, b) => (b.span?.[0] ?? -Infinity) - (a.span?.[0] ?? -Infinity) || a.i - b.i)
  const titles = [profile.contact.headline, ...dated.slice(0, 2).map((d) => d.e.role)]
    .map(shortTitle)
    .filter(Boolean)
  const location = profile.contact.location.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const spans = dated.map((d) => d.span).filter((s): s is [number, number] => s !== null)
  return {
    titles: [...new Map(titles.map((t) => [t.toLowerCase(), t])).values()],
    skills: buildKnowledgeGraph(profile, [], now)
      .skills.filter((s) => !s.gap)
      .map((s) => s.name),
    location: /^remote\b/i.test(location) ? '' : location,
    remote: /^remote\b/i.test(location),
    needsSponsorship: needsSponsorshipFrom([profile.contact.workAuthorization, ...profile.gaps].join('\n')),
    years: Math.round(mergedYears(spans) * 10) / 10,
    degrees: profile.education
      .map((e) => ({ degree: e.degree.trim(), field: e.field.trim() }))
      .filter((d) => d.degree || d.field),
    evidence: evidenceText(profile)
  }
}

/** Whether the profile says enough for a Relevant view: a headline or a role. */
export function hasRelevanceSignals(s: Pick<ProfileSignals, 'titles'>): boolean {
  return s.titles.length > 0
}

/** Seniority words do not decide whether two titles name the same job. */
const IGNORED = new Set(
  'a an and of the for to in at with on senior sr junior jr staff principal lead mid level entry i ii iii iv v'.split(' ')
)
/** Words most titles share; they count, but a title matching only on them is not a match of its own. */
const GENERIC = new Set(
  'engineer engineering developer development software manager specialist analyst consultant programmer'.split(' ')
)
const GENERIC_WEIGHT = 0.3

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/\bfront[\s-]?end\b/g, 'frontend')
    .replace(/\bback[\s-]?end\b/g, 'backend')
    .replace(/\bfull[\s-]?stack\b/g, 'fullstack')
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w && !IGNORED.has(w))
}

/** How much of a target title the job title covers (0–1), and whether a specific word matched. */
function titleMatch(jobTitle: string, target: string): { cover: number; core: boolean } {
  const want = [...new Set(titleWords(target))]
  if (want.length === 0) return { cover: 0, core: false }
  const have = new Set(titleWords(jobTitle))
  const weight = (w: string) => (GENERIC.has(w) ? GENERIC_WEIGHT : 1)
  const matched = want.filter((w) => have.has(w))
  const cover = matched.reduce((n, w) => n + weight(w), 0) / want.reduce((n, w) => n + weight(w), 0)
  // "Software Engineer" is all generic words: covering all of them is a match.
  const core = matched.some((w) => !GENERIC.has(w)) || (cover === 1 && want.every((w) => GENERIC.has(w)))
  return { cover, core }
}

/** Years a seniority asks for, or `null` when unknown. */
function yearsAskedFor(job: Job): number | null {
  if (typeof job.minYearsExperience === 'number') return job.minYearsExperience
  if (/\b(?:staff|principal|distinguished)\b/i.test(job.title)) return 8
  switch (seniorityOf(job)) {
    case 'No Prior Experience Required':
    case 'Entry Level':
      return 0
    case 'Mid Level':
      return 3
    case 'Senior Level':
      return 5
    default:
      return null
  }
}

export interface JobScore {
  /** 0–100. */
  score: number
  /** Why it fits, for the card: "Title: Backend Engineer", "Skills: Go, AWS", "Remote", … */
  reasons: string[]
  /** Set when the job is never relevant: dismissed, or no sponsorship for someone who needs it. */
  excluded?: string
  /** The title has a specific word in common with a target title, or at least one skill matches. */
  matched: boolean
  /** The match score (#149) behind the skills part: what the job asks for, what the profile has, failed gates. */
  match: MatchResult
}

const DAY_MS = 86_400_000

/** The best of the profile's target titles for a job title: how much of it the job covers, and whether a specific word matched. */
function bestTitle(job: Pick<Job, 'title'>, s: Pick<ProfileSignals, 'titles'>): { cover: number; core: boolean; target: string } {
  let title = { cover: 0, core: false, target: '' }
  for (const target of s.titles) {
    const m = titleMatch(job.title, target)
    if (m.cover > title.cover) title = { ...m, target }
  }
  return title
}

/** Seniority part (0–1): the years the job asks for against the profile's; 0.5 when unknown. */
function seniorityFit(job: Job, s: Pick<ProfileSignals, 'years'>): number {
  const asked = yearsAskedFor(job)
  if (asked === null) return 0.5
  const entry = asked === 0
  if (s.years >= asked) return entry && s.years >= 6 ? 0.5 : 1
  return asked - s.years <= 2 ? 0.5 : 0
}

/** Location part (0–1) and its reason: remote, or near the profile's location; 0.5 when the profile names none. */
function locationFit(job: Job, s: Pick<ProfileSignals, 'remote' | 'location'>): { fit: number; reason?: string } {
  if (job.remote) return { fit: 1, reason: 'Remote' }
  if (!s.remote && !s.location) return { fit: 0.5 }
  if (!s.remote && job.location && matchesLocation(job, s.location)) return { fit: 1, reason: `Near ${s.location.split(',')[0].trim()}` }
  return { fit: 0 }
}

export function scoreJob(job: Job, s: ProfileSignals, now = new Date()): JobScore {
  const reasons: string[] = []
  const sponsors = sponsorshipOf(job)

  const title = bestTitle(job, s)
  if (title.core) reasons.push(`Title: ${title.target}`)

  const match = matchScore(job, s)
  const skills = match.matched.map((m) => m.skill)
  if (skills.length > 0) reasons.push(`Skills: ${skills.slice(0, 4).join(', ')}${skills.length > 4 ? ` +${skills.length - 4}` : ''}`)

  const seniority = seniorityFit(job, s)

  const { fit: location, reason: near } = locationFit(job, s)
  if (near) reasons.push(near)

  let recency = 0.3
  const posted = job.postedAt ? Date.parse(job.postedAt) : NaN
  if (Number.isFinite(posted)) {
    const days = (now.getTime() - posted) / DAY_MS
    recency = days <= 7 ? 1 : days <= 30 ? 0.5 : 0
    if (days <= 7) reasons.push('Posted this week')
  }

  if (sponsors === true) reasons.push('Sponsors visas')

  const score = Math.round(
    WEIGHT.title * title.cover +
      (WEIGHT.skills * match.score) / 100 +
      WEIGHT.seniority * seniority +
      WEIGHT.location * location +
      WEIGHT.recency * recency
  )
  const excluded = job.dismissed
    ? 'Dismissed'
    : s.needsSponsorship && sponsors === false
      ? 'Says it does not sponsor visas'
      : undefined
  return { score, reasons, excluded, matched: title.core || skills.length > 0, match }
}

/** A title-only estimate (#150): Relevant's title, seniority and location parts, out of 100, with their reasons. */
export interface TitleEstimate {
  score: number
  reasons: string[]
}

/**
 * How well a job fits from its title, seniority and location alone, for a job that names no requirement to
 * match (an Explore row from the GitHub README, #150): `scoreJob`'s title, seniority and location parts,
 * rescaled to 0–100. Skills and recency are left out: there are none to read, and recency is not fit.
 */
export function titleEstimate(job: Job, s: Pick<ProfileSignals, 'titles' | 'years' | 'remote' | 'location'>): TitleEstimate {
  const title = bestTitle(job, s)
  const seniority = seniorityFit(job, s)
  const location = locationFit(job, s)
  const reasons = [
    title.core ? `Title: ${title.target}` : 'No target title in common',
    ...(location.reason ? [location.reason] : [])
  ]
  const max = WEIGHT.title + WEIGHT.seniority + WEIGHT.location
  const score = Math.round(((WEIGHT.title * title.cover + WEIGHT.seniority * seniority + WEIGHT.location * location.fit) / max) * 100)
  return { score, reasons }
}

export interface ScoredJob {
  job: Job
  score: JobScore
}

/** The relevant jobs, best first (ties: newest posting first). */
export function relevantJobs(
  jobs: readonly Job[],
  s: ProfileSignals,
  now = new Date(),
  threshold = RELEVANCE_THRESHOLD
): ScoredJob[] {
  if (!hasRelevanceSignals(s)) return []
  return rankRelevant(
    jobs.map((job) => ({ job, score: scoreJob(job, s, now) })),
    threshold
  )
}

/**
 * The relevant jobs among already scored ones, best first (ties: newest posting first): what
 * `relevantJobs` returns, for a caller that keeps the score of every job (the Jobs page's Scent rings).
 */
export function rankRelevant(scored: readonly ScoredJob[], threshold = RELEVANCE_THRESHOLD): ScoredJob[] {
  return scored
    .filter(({ score }) => !score.excluded && score.matched && score.score >= threshold)
    .sort(
      (a, b) =>
        b.score.score - a.score.score ||
        (b.job.postedAt ?? b.job.fetchedAt).localeCompare(a.job.postedAt ?? a.job.fetchedAt)
    )
}
