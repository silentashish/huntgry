import type { ReviewTracking } from './review-types'

/**
 * Generated applications: the `<role>/<company>/<job-id>/` folders the
 * resume-tailor skill writes into the workspace, plus Huntgry's tracking
 * metadata (`huntgry.json` in the same folder).
 */

export const APPLICATION_STATUSES = ['generated', 'applied', 'interviewing', 'offer', 'rejected', 'archived'] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

/** Where the job came from. */
export type JobSource = 'indeed' | 'hiring.cafe' | 'manual' | (string & {})

/** Contents of `<job folder>/huntgry.json`. Written only by Huntgry; the skill never reads it. */
export interface ApplicationTracking {
  status: ApplicationStatus
  /** ISO date (YYYY-MM-DD) the application was sent. */
  appliedAt?: string
  /** ISO time the status became `archived`; cleared when it leaves it. The Board hides a card a week after (#85). */
  archivedAt?: string
  /**
   * ISO time the status last changed (#160). Tracking edits do not change the application's
   * `updatedAt` (its files' times), so the Board dates a moved card by this.
   */
  statusChangedAt?: string
  notes: string
  /** Job posting URL; overrides the one found in `job-description.md`. */
  jobUrl?: string
  source?: JobSource
  /** Set by the unattended pipeline (#31); cleared only by the Review page. */
  review?: ReviewTracking
  /** The re-score after tailoring (#151): written by main when a run's turn ends with a built resume. */
  match?: ApplicationMatch
}

/**
 * `huntgry.json` → `match`: profile fit, resume coverage and surfaced share (`resumeCoverage`,
 * `src/shared/resume-coverage.ts`) of the application's resume, kept as main computed them. Only main
 * writes it (the renderer's tracking patches can't), after every turn that leaves a built resume, so
 * a re-run replaces it; it is dropped when the job names no requirement or the resume can't be read.
 */
export interface ApplicationMatch {
  /** 0–100: the job's match score against the master profile, the ceiling. */
  profileFit: number
  /** 0–100: the same requirements matched against the resume. */
  resumeCoverage: number
  /** 0–100: how much of what the profile matched the resume shows; absent when the profile matched nothing. */
  surfaced?: number
  /** How many requirements the job names. */
  requirements: number
  /** Requirements the profile has and the resume left out, heaviest first (at most `MAX_MATCH_LIST`). */
  leftOut: string[]
  /** The skill's own hint: the `jd_keyword_coverage` terms of `build-report.json` absent from the resume. */
  absent?: string[]
  /** Failed must-haves (they cap both numbers), as reasons. */
  gates?: string[]
  /** What the resume's words were read from. */
  resumeFrom: 'resume_data.json' | 'resume.pdf'
  /** Where the requirements came from (`MatchSource`). */
  source: 'jobright-skills' | 'description'
  /** The run whose turn wrote it, when known. */
  runId?: string
  /** ISO time it was computed. */
  at: string
}

/** Most names `ApplicationMatch.leftOut` / `absent` / `gates` keep. */
export const MAX_MATCH_LIST = 20

export interface BuildSummary {
  /** `build-report.json` → `ok`; `unknown` when there is no readable report. */
  status: 'pass' | 'fail' | 'unknown'
  /** Names of failed verify checks. */
  failed: string[]
  warnings: number
  resumePages: number | null
}

export interface ApplicationRecord {
  /** Folder relative to the workspace, `/`-separated; the stable id of the application. */
  id: string
  role: string
  company: string
  jobId: string
  /** First heading or line of `job-description.md`. */
  jobTitle: string
  /** Tracking `jobUrl`, else the first URL in `job-description.md`. */
  jobUrl: string | null
  createdAt: string
  updatedAt: string
  /** Files present in the folder that the app knows how to use. */
  files: string[]
  /** Page images rendered by the skill (`resume-page-1.jpg`, …), in page order. */
  resumePages: string[]
  coverPages: string[]
  build: BuildSummary
  tracking: ApplicationTracking
}

export interface ApplicationsList {
  applications: ApplicationRecord[]
  /** The scan stopped at its entry budget; some folders may be missing. */
  truncated: boolean
}

export interface ApplicationsApi {
  list(): Promise<ApplicationsList>
  /** One application by id, read directly (never limited by the list's scan budget). */
  get(id: string): Promise<ApplicationRecord>
  /** Merge a change into `huntgry.json`; returns the updated record. */
  updateTracking(id: string, patch: Partial<ApplicationTracking>): Promise<ApplicationRecord>
  readJobDescription(id: string): Promise<string>
  /** Open a file of the application with the OS (PDF viewer, editor). */
  openFile(id: string, file: string): Promise<void>
  reveal(id: string): Promise<void>
  /** `huntgry-file://` URL of a page image for `<img src>`. */
  fileUrl(id: string, file: string): string
}

export const APPLICATIONS_CHANNELS = {
  list: 'applications:list',
  get: 'applications:get',
  updateTracking: 'applications:update-tracking',
  readJobDescription: 'applications:read-job-description',
  openFile: 'applications:open-file',
  reveal: 'applications:reveal'
} as const

export interface ApplicationsEvents {
  /** Something changed on disk under the workspace; re-list. */
  'applications:changed': null
}

/** Scheme serving page images of the current workspace to the renderer. */
export const FILE_SCHEME = 'huntgry-file'

/** `huntgry-file://app/<id>/<file>`; each path segment is URI-encoded. */
export function applicationFileUrl(id: string, file: string): string {
  const path = [...id.split('/'), file].map(encodeURIComponent).join('/')
  return `${FILE_SCHEME}://app/${path}`
}

export const DEFAULT_TRACKING: ApplicationTracking = { status: 'generated', notes: '' }
