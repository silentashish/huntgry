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
  notes: string
  /** Job posting URL; overrides the one found in `job-description.md`. */
  jobUrl?: string
  source?: JobSource
}

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
