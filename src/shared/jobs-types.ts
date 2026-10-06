/**
 * Jobs found on job boards (hiring.cafe, Indeed) or added by URL / pasted
 * text, normalized to one shape and saved in the workspace
 * (`.huntgry/jobs/<source>-<id>.json`).
 */

import type { JobsPrefs, JobsPrefsPatch } from './jobs-prefs'

export type JobSourceId = 'hiring.cafe' | 'indeed' | 'url' | 'pasted'

/** Shape of `Job.id`, checked on every id the renderer sends. */
export const JOB_ID_PATTERN = /^(hiring\.cafe|indeed|url|pasted):[\w.:-]{1,200}$/

export const SEARCH_SOURCES = ['hiring.cafe', 'indeed'] as const
export type SearchSource = (typeof SEARCH_SOURCES)[number]

/** hiring.cafe's `workplace_type` values. */
export type WorkplaceType = 'Remote' | 'Hybrid' | 'Onsite' | 'Field'

export interface Job {
  /** `<source>:<source id>`; stable across searches, used for dedupe. */
  id: string
  source: JobSourceId
  sourceId: string
  title: string
  company: string
  location: string
  remote: boolean
  /** Human-readable pay, e.g. `$120,000 – $140,000 / year`. */
  salary: string
  /** ISO date the posting went up, when known. */
  postedAt: string | null
  /** Where the job can be read and applied to. */
  url: string
  /** Board page for the job, when different from `url`. */
  boardUrl: string | null
  /**
   * Job description as plain text / Markdown. Search results carry only a
   * summary; `descriptionComplete` says whether this is the full posting.
   */
  description: string
  descriptionComplete: boolean
  /** Technologies the board extracted (hiring.cafe), if any. */
  tags: string[]
  fetchedAt: string
  /** Set when the user sent the job to the resume tailor. */
  tailoredAt?: string
  dismissed?: boolean
  /** Ids of the same job found on other boards, merged into this record (see `canonicalize`). */
  aliases?: string[]
  /*
   * Structured facts a board extracted (hiring.cafe's `v5_processed_job_data`). All optional: jobs saved
   * before #73, and jobs from Indeed, by URL or pasted, do not have them; `undefined`/`null` means unknown.
   */
  /** The board's reading of the posting: `true` sponsors a visa; `false` is often "not mentioned". */
  visaSponsorship?: boolean | null
  /** e.g. `Entry Level`, `Mid Level`, `Senior Level`. */
  seniority?: string
  minYearsExperience?: number | null
  /** e.g. `['Full Time']`. */
  commitment?: string[]
  workplaceType?: WorkplaceType | ''
  /** Yearly pay range in the posting's currency. */
  salaryMin?: number | null
  salaryMax?: number | null
}

export interface JobQuery {
  keywords: string
  location: string
  remoteOnly: boolean
  sources: SearchSource[]
}

/** Result of one source for one search. */
export interface SourceResult {
  source: SearchSource
  status: 'ok' | 'blocked' | 'error'
  /** Jobs this source returned (already saved and deduped). */
  count: number
  message?: string
}

export interface SearchResult {
  jobs: Job[]
  sources: SourceResult[]
}

export interface SavedSearch {
  query: JobQuery
  at: string
}

/** A profile-derived search (the Refresh button, or the automatic one when Jobs opens). */
export interface RefreshResult extends SearchResult {
  query: JobQuery
  at: string
}

export interface JobsApi {
  /** Saved jobs of the workspace, newest first (dismissed ones included, flagged). */
  list(): Promise<Job[]>
  /** Searches the selected boards now (rate-limited), saves the results, returns them. */
  search(query: JobQuery): Promise<SearchResult>
  /** Fetches the full description for a saved job and saves it. */
  fetchDetails(id: string): Promise<Job>
  /** Fetches any job posting URL and saves it as a job. */
  addByUrl(url: string): Promise<Job>
  /** Saves pasted posting text as a job. */
  addPasted(input: { title: string; company: string; url: string; text: string }): Promise<Job>
  update(id: string, patch: { dismissed?: boolean; tailored?: boolean }): Promise<Job>
  recentSearches(): Promise<SavedSearch[]>
  /**
   * Searches the boards for jobs like the master profile (its headline or latest role, and its location),
   * saves them and records the time in the Jobs preferences. A refresh already running for the workspace is
   * joined, not repeated. `auto`: the refresh on opening Jobs, which runs only when it is due (auto-refresh on,
   * last refresh 12 h old) and resolves to `null` otherwise.
   */
  refresh(input: { sources: SearchSource[]; auto?: boolean }): Promise<RefreshResult | null>
  /** The workspace's Jobs preferences: filters, auto-refresh, last search and last refresh. */
  prefs(): Promise<JobsPrefs>
  /** Saves filters and the auto-refresh toggle (validated in main); returns the whole preferences. */
  setPrefs(patch: JobsPrefsPatch): Promise<JobsPrefs>
}

export const JOBS_CHANNELS = {
  list: 'jobs:list',
  search: 'jobs:search',
  fetchDetails: 'jobs:fetch-details',
  addByUrl: 'jobs:add-by-url',
  addPasted: 'jobs:add-pasted',
  update: 'jobs:update',
  recentSearches: 'jobs:recent-searches',
  refresh: 'jobs:refresh',
  prefs: 'jobs:prefs',
  setPrefs: 'jobs:set-prefs'
} as const

/** Builds the job description handed to the resume tailor. */
export function jobDescriptionFor(job: Job): string {
  const head = [
    `# ${job.title}`,
    '',
    [job.company, job.location, job.remote ? 'Remote' : '', job.salary].filter(Boolean).join(' · ')
  ]
  if (job.url) head.push('', `Posting: ${job.url}`)
  // Pasted postings often start with their own title heading; do not repeat it.
  const lines = job.description.trim().split('\n')
  const same = (l: string) =>
    l
      .replace(/^#+\s*/, '')
      .trim()
      .toLowerCase() === job.title.trim().toLowerCase()
  const body = lines.length > 0 && same(lines[0]) ? lines.slice(1).join('\n').trim() : job.description.trim()
  return [...head, '', body].join('\n')
}

/**
 * Whether the full description can be fetched from an employer page: only a
 * summary is saved, and the job is not Indeed-only (Indeed job pages need a
 * human check; a copy of the same job found on another board still loads).
 */
export function canFetchDetails(job: Job): boolean {
  return !job.descriptionComplete && (job.source !== 'indeed' || (job.aliases?.length ?? 0) > 0)
}

/**
 * Short id for the application folder (`<role>/<company>/<job-id>`), from the
 * board's own id: Indeed's job key, the employer requisition number at the end
 * of a hiring.cafe id (`adp___<uuid>___594192` → `594192`), or the URL/pasted hash.
 */
export function jobIdFor(job: Job): string {
  const raw = job.source === 'hiring.cafe' ? (job.sourceId.split('___').pop() ?? '') : job.sourceId
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '')
  return slug(raw) || slug(job.sourceId) || slug(job.id)
}

/** What the Tailor form is pre-filled with when a job is sent from the Jobs page. */
export interface TailorPrefill {
  /**
   * The saved description (`jobDescriptionFor`), so the run never refetches a job board URL;
   * empty when the board gave no text at all (a title/URL header alone is not a posting).
   */
  jobDescription: string
  jobUrl?: string
  company?: string
  role: string
  jobId: string
  source: JobSourceId
  /** `false` when the description is only the board's summary or snippet. */
  descriptionComplete: boolean
}

export function tailorPrefillFor(job: Job): TailorPrefill {
  return {
    jobDescription: job.description.trim() ? jobDescriptionFor(job) : '',
    jobUrl: job.url || undefined,
    company: job.company || undefined,
    role: job.title,
    jobId: jobIdFor(job),
    source: job.source,
    descriptionComplete: job.descriptionComplete
  }
}
