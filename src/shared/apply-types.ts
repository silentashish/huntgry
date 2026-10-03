/**
 * Auto-apply (#24): open a tailored application's apply page in the in-app
 * browser, fill it from the master profile and attach the tailored PDFs.
 * Huntgry never submits; the user reviews the page and clicks the site's own
 * Submit button. The renderer sends application and session ids only; values,
 * file paths and pages stay in main.
 */

/**
 * Applicant tracking systems Huntgry knows; `generic` is the label/autocomplete
 * heuristic. Each has an adapter in `src/shared/autofill/adapters/` (an ATS
 * without one yet is recognised by host and filled with the generic rules).
 */
export type ApplyAts = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'generic'

export const APPLY_ATS: readonly ApplyAts[] = ['greenhouse', 'lever', 'ashby', 'workday', 'generic']

export const ATS_LABEL: Record<ApplyAts, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  generic: 'Unknown site (generic matching)'
}

/**
 * Where the page is in the site's apply flow (an adapter's `step` hook):
 * - `form`: an application form to fill (the default).
 * - `posting`: the job posting; the user presses the site's Apply.
 * - `choice`: the site asks how to apply (e.g. Workday's "Autofill with Resume" / "Apply Manually").
 * - `account-wall`: sign in or create an account; Huntgry fills nothing.
 * - `other`: anything else.
 */
export type AdapterStep = 'form' | 'posting' | 'choice' | 'account-wall' | 'other'

export const ADAPTER_STEPS: readonly AdapterStep[] = ['form', 'posting', 'choice', 'account-wall', 'other']

/** What the site's upload widget shows after an attach: the file, still uploading, or nothing. */
export type UploadState = 'attached' | 'pending' | 'missing'

/** What a form field is filled with. */
export type FieldKey =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'location'
  | 'linkedin'
  | 'github'
  | 'website'
  | 'currentCompany'
  | 'resume'
  | 'coverLetter'

/** Text values, all from the master profile's contact block (empty string = not known). */
export type FillValues = Record<Exclude<FieldKey, 'resume' | 'coverLetter'>, string>

export const FIELD_LABEL: Record<FieldKey, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  email: 'Email',
  phone: 'Phone',
  location: 'Location',
  linkedin: 'LinkedIn',
  github: 'GitHub',
  website: 'Website',
  currentCompany: 'Current company',
  resume: 'Resume (resume.pdf)',
  coverLetter: 'Cover letter (cover.pdf)'
}

export type FieldKind = 'text' | 'textarea' | 'file' | 'select' | 'checkbox' | 'radio' | 'combobox' | 'other'

/**
 * - `filled`: written and read back.
 * - `kept`: the field already held another value (the user's); left as is.
 * - `skipped-no-value`: the profile has nothing for it (or there is no cover.pdf).
 * - `skipped-unsupported`: a choice (select, combobox, checkbox, radio) or consent / demographic question; always the user's.
 * - `unmatched`: a question Huntgry does not answer (custom questions, dates…).
 * - `ambiguous`: several fields looked like the same thing; none was filled.
 * - `rejected`: the site changed or refused the value.
 * - `to-upload`: a file field marked for upload (main replaces this with `uploaded` / `upload-failed`).
 */
export type FillOutcome =
  | 'filled'
  | 'kept'
  | 'skipped-no-value'
  | 'skipped-unsupported'
  | 'unmatched'
  | 'ambiguous'
  | 'rejected'
  | 'to-upload'
  | 'uploaded'
  | 'upload-failed'

export interface FieldReport {
  key: FieldKey | null
  /** Label text from the page (untrusted; render as text). */
  label: string
  kind: FieldKind
  required: boolean
  outcome: FillOutcome
  /** What was written (text fields) or attached (file name). */
  value?: string
  reason?: string
}

export interface FillReport {
  ats: ApplyAts
  url: string
  fields: FieldReport[]
  /** The form has a submit button (for the user; Huntgry never presses it). */
  hasSubmitButton: boolean
  /** The adapter's upload order: `files-first` reports file fields only, and main fills text after the upload (default `text-first`). */
  uploadOrder?: 'text-first' | 'files-first'
  /** The step the page was on; anything but `form` is never filled (the report is then empty). */
  step?: AdapterStep
  /** The step's title on multi-step forms ("My Information"), or null. */
  stepTitle?: string | null
  /** Multi-step forms: the profile fields the step showed, comma-separated (see `PageScan.stepFields`). */
  stepFields?: string | null
}

/** What the guest page reports on each load. */
export interface PageScan {
  ats: ApplyAts
  url: string
  title: string
  /** Start of the page text, for bot-wall detection in main. */
  text: string
  /** The site's own "application submitted" page. */
  confirmation: boolean
  /** A form with fillable fields (or a file input) was found. */
  formFound: boolean
  /** A résumé/CV file input was found (a good sign this is an application form). */
  hasResumeInput: boolean
  /** An ATS form embedded in an iframe on a company page (e.g. Greenhouse `/embed/job_app`); opened directly. */
  embedUrl: string | null
  /** The adapter's view of the page (`form` unless the adapter says otherwise). */
  step: AdapterStep
  /** The step's title on multi-step forms, or null. */
  stepTitle: string | null
  /**
   * Multi-step forms: the profile fields the step shows now (sorted, comma-separated, e.g. `email,firstName`),
   * so a field rendered after the first fill is filled too. Null for single-page adapters.
   */
  stepFields: string | null
  /** The adapter's readiness (Workday: no spinner, e.g. while it parses the resume); a form step that is not ready waits. */
  ready: boolean
}

export type ApplyStatus =
  /** Tab opened, page loading. */
  | 'opened'
  /** Page loaded; no form filled automatically (press Fill form). */
  | 'ready'
  /** A step of the site's flow that is the user's: press its Apply, choose how to apply, sign in (see `step`). */
  | 'waiting'
  | 'filling'
  | 'filled'
  /** The site's confirmation page is showing; offer Mark as applied. */
  | 'submitted-detected'
  /** The page is a bot wall / human check. */
  | 'blocked'
  /** The user closed the tab. */
  | 'closed'
  | 'error'

export interface ApplySession {
  id: string
  applicationId: string
  /** "Role · Company", for the panel. */
  title: string
  tabId: string
  applyUrl: string
  ats: ApplyAts | null
  status: ApplyStatus
  report: FillReport | null
  /** Whether the application has a cover.pdf to attach. */
  hasCover: boolean
  message: string | null
  /** Where the page is in the site's apply flow, when the adapter knows (multi-step sites such as Workday). */
  step?: { kind: AdapterStep; title: string | null } | null
}

export interface ApplyApi {
  /** Opens the application's apply page in a new in-app tab and starts filling it (a previous session ends). */
  start(applicationId: string): Promise<ApplySession>
  /** Fills the tab's current page again (text fields left empty, then resume/cover upload). */
  fill(sessionId: string): Promise<ApplySession>
  /** Ends the session; the tab stays open. */
  cancel(sessionId: string): Promise<void>
  current(): Promise<ApplySession | null>
}

export const APPLY_CHANNELS = {
  start: 'apply:start',
  fill: 'apply:fill',
  cancel: 'apply:cancel',
  current: 'apply:current'
} as const

export interface ApplyEvents {
  /** The session after every change; `null` when it ended. */
  'apply:session': ApplySession | null
}
