import type { Job, WorkplaceType } from './jobs-types'

/**
 * Filters of the saved-job list (#73) and the facts they read from a job.
 * Pure and shared: the renderer filters with them, main validates the saved
 * choices with `normalizeFilters`. Every filter runs on saved jobs, so it
 * works the same for every board and for jobs saved before the structured
 * fields existed: a fact that is unknown passes a filter, except "Only
 * sponsors" and a minimum salary, which need the fact to be known.
 */

export const SPONSORSHIP_FILTERS = ['any', 'hide-no', 'only-yes'] as const
export type SponsorshipFilter = (typeof SPONSORSHIP_FILTERS)[number]

export const WORKPLACE_FILTERS = ['Remote', 'Hybrid', 'Onsite'] as const satisfies readonly WorkplaceType[]
export type WorkplaceFilter = (typeof WORKPLACE_FILTERS)[number]

/** hiring.cafe's seniority levels; other boards' jobs get one from their title (`seniorityOf`). */
export const SENIORITY_LEVELS = ['No Prior Experience Required', 'Entry Level', 'Mid Level', 'Senior Level'] as const
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number]

export const POSTED_WITHIN_DAYS = [0, 1, 3, 7, 14, 30] as const
export type PostedWithinDays = (typeof POSTED_WITHIN_DAYS)[number]

export interface JobFilters {
  sponsorship: SponsorshipFilter
  /** Empty: any workplace. */
  workplace: WorkplaceFilter[]
  /** Empty: any seniority. */
  seniority: SeniorityLevel[]
  /** 0: any time. */
  postedWithinDays: PostedWithinDays
  /** Yearly, in the posting's currency; `null`: no minimum. */
  minSalary: number | null
}

export const DEFAULT_FILTERS: JobFilters = {
  sponsorship: 'any',
  workplace: [],
  seniority: [],
  postedWithinDays: 0,
  minSalary: null
}

const MAX_SALARY = 10_000_000

/** Filters from untrusted input (IPC, an old prefs file): unknown values are dropped, never thrown on. */
export function normalizeFilters(input: unknown): JobFilters {
  const f = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const pick = <T extends string>(allowed: readonly T[], v: unknown): T[] =>
    Array.isArray(v) ? allowed.filter((a) => v.includes(a)) : []
  const salary = typeof f.minSalary === 'number' && Number.isFinite(f.minSalary) ? Math.round(f.minSalary) : null
  return {
    sponsorship: SPONSORSHIP_FILTERS.find((s) => s === f.sponsorship) ?? 'any',
    workplace: pick(WORKPLACE_FILTERS, f.workplace),
    seniority: pick(SENIORITY_LEVELS, f.seniority),
    postedWithinDays: POSTED_WITHIN_DAYS.find((d) => d === f.postedWithinDays) ?? 0,
    minSalary: salary !== null && salary > 0 && salary <= MAX_SALARY ? salary : null
  }
}

/** How many filters differ from the defaults (for "Clear filters"). */
export function activeFilterCount(f: JobFilters): number {
  return [
    f.sponsorship !== 'any',
    f.workplace.length > 0,
    f.seniority.length > 0,
    f.postedWithinDays !== 0,
    f.minSalary !== null
  ].filter(Boolean).length
}

/** Phrases by which a posting says it will not sponsor a visa, or wants citizens only. */
const NO_SPONSORSHIP = [
  /\b(?:unable|not able|cannot|can ?not|can't|won't|will not|do not|does not|don't|doesn't|is not|are not)\b[^.;\n]{0,40}\bsponsor/i,
  /\bwithout\b[^.;\n]{0,40}\bsponsorship\b/i,
  /\bno\s+(?:visa\s+|h-?1b\s+|immigration\s+)?sponsorship\b/i,
  /\bsponsorship\b[^.;\n]{0,20}\bnot\s+(?:available|offered|provided|possible)\b/i,
  /\bnot\s+(?:eligible|available)\s+for\s+(?:visa\s+)?sponsorship\b/i,
  /\b(?:u\.?s\.?|united states)\s+citizens?\s+only\b/i,
  /\bmust\s+be\s+(?:an?\s+)?(?:u\.?s\.?|united states)\s+citizens?\b/i,
  /\b(?:u\.?s\.?\s+)?citizenship\s+(?:is\s+)?required\b/i
]

/** A sentence that asks for a security clearance (which in practice means citizens only). */
const CLEARANCE_REQUIRED = [
  /\b(?:must|required to|need to|will)\s+(?:have|hold|possess|obtain|maintain|be able to obtain)\b[^.;\n]{0,40}\bclearance\b/i,
  /\b(?:active|current)\s+(?:dod\s+)?(?:security\s+|secret\s+|top secret\s+|ts\/sci\s+)?clearance\b/i,
  /\bclearance\s+(?:is\s+)?required\b/i,
  /\brequires?\s+(?:an?\s+)?(?:active\s+)?(?:security\s+|secret\s+|top secret\s+|ts\/sci\s+)?clearance\b/i
]
/** "No clearance is required", "clearance not needed", "clearance preferred": not a requirement. */
const CLEARANCE_WAIVED = /\b(?:no|not|n't|without|optional|preferred|a plus|nice to have)\b/i

function requiresClearance(text: string): boolean {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((s) => /\bclearance\b/i.test(s) && !CLEARANCE_WAIVED.test(s) && CLEARANCE_REQUIRED.some((re) => re.test(s)))
}

/** Phrases by which a posting offers sponsorship. */
const SPONSORSHIP = [
  /\b(?:h-?1b|visa|immigration)\s+(?:sponsorship|transfers?)\s+(?:is\s+|are\s+)?(?:available|offered|provided|supported|possible)\b/i,
  /\bsponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\b(?:will|can|we|happy to|able to|willing to)\s+(?:sponsor|provide\s+(?:visa\s+)?sponsorship|offer\s+(?:visa\s+)?sponsorship)\b/i,
  /\bsponsors?\s+(?:h-?1b|visas?)\b/i
]

/**
 * What a posting's text says about visa sponsorship: `false` when it says it
 * will not sponsor (or wants citizens only, or a clearance), `true` when it
 * offers sponsorship, `null` when it does not say. A refusal wins over an offer.
 */
export function sponsorshipFromText(text: string): boolean | null {
  if (NO_SPONSORSHIP.some((re) => re.test(text)) || requiresClearance(text)) return false
  if (SPONSORSHIP.some((re) => re.test(text))) return true
  return null
}

/**
 * Whether a job sponsors a visa. The board's `true` is trusted; its `false`
 * is not, because hiring.cafe gives `false` for postings that simply do not
 * mention it. So "no" comes only from the posting's own words.
 */
export function sponsorshipOf(job: Pick<Job, 'visaSponsorship' | 'description'>): boolean | null {
  if (job.visaSponsorship === true) return true
  return sponsorshipFromText(job.description)
}

/** The job's seniority level: the board's, else read from the title ("Senior", "Staff", "Junior", …). */
export function seniorityOf(job: Pick<Job, 'seniority' | 'title'>): SeniorityLevel | '' {
  const known = SENIORITY_LEVELS.find((s) => s.toLowerCase() === job.seniority?.trim().toLowerCase())
  if (known) return known
  const t = job.title
  if (/\b(?:intern|internship|new grad(?:uate)?|apprentice)\b/i.test(t)) return 'No Prior Experience Required'
  if (/\b(?:junior|jr\.?|entry[- ]level|associate)\b/i.test(t)) return 'Entry Level'
  if (/\b(?:senior|sr\.?|staff|principal|lead|distinguished)\b/i.test(t)) return 'Senior Level'
  if (/\b(?:mid[- ]level|intermediate)\b/i.test(t)) return 'Mid Level'
  return ''
}

/** Workplace type, falling back to the `remote` flag; `''` when unknown. Field work counts as on site. */
export function workplaceOf(job: Pick<Job, 'workplaceType' | 'remote'>): WorkplaceFilter | '' {
  if (job.workplaceType === 'Field') return 'Onsite'
  if (job.workplaceType) return job.workplaceType
  return job.remote ? 'Remote' : ''
}

/**
 * Yearly pay range: the board's numbers, else read from the salary text
 * (`$140,000 - $165,000 a year`, `$60 an hour`, `120k`). `null` when unknown.
 */
export function salaryRange(job: Pick<Job, 'salaryMin' | 'salaryMax' | 'salary'>): { min: number; max: number } | null {
  const lo = job.salaryMin ?? null
  const hi = job.salaryMax ?? null
  if (lo !== null || hi !== null) return { min: lo ?? hi!, max: hi ?? lo! }
  const text = job.salary
  if (!text) return null
  const scale = /\b(?:hour|hr|hourly)\b/i.test(text) ? 2080 : /\bmonth(?:ly)?\b/i.test(text) ? 12 : 1
  const values = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?/g)]
    .map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1) * scale)
    .filter((v) => v >= 1000)
  if (values.length === 0) return null
  return { min: Math.min(...values), max: Math.max(...values) }
}

/**
 * Whether a job fits a location: remote jobs always do; otherwise the city
 * (first part of "Atlanta, GA") must appear in the job's location.
 */
export function matchesLocation(job: { location: string; remote: boolean }, location: string): boolean {
  const city = location.split(',')[0].trim().toLowerCase()
  return !city || job.remote || job.location.toLowerCase().includes(city)
}

const DAY_MS = 86_400_000

/** Whether a saved job passes every filter. */
export function matchesFilters(job: Job, f: JobFilters, now = new Date()): boolean {
  if (f.sponsorship !== 'any') {
    const sponsors = sponsorshipOf(job)
    if (f.sponsorship === 'hide-no' && sponsors === false) return false
    if (f.sponsorship === 'only-yes' && sponsors !== true) return false
  }
  if (f.workplace.length > 0) {
    const w = workplaceOf(job)
    // Not remote and nothing more known: it may be hybrid or on site, so only a "Remote only" choice hides it.
    if (w ? !f.workplace.includes(w) : !f.workplace.some((x) => x !== 'Remote')) return false
  }
  if (f.seniority.length > 0) {
    const s = seniorityOf(job)
    if (s && !f.seniority.includes(s)) return false
  }
  if (f.postedWithinDays > 0 && job.postedAt) {
    const posted = Date.parse(job.postedAt)
    if (Number.isFinite(posted) && now.getTime() - posted > f.postedWithinDays * DAY_MS) return false
  }
  if (f.minSalary !== null) {
    const pay = salaryRange(job)
    if (!pay || pay.max < f.minSalary) return false
  }
  return true
}
