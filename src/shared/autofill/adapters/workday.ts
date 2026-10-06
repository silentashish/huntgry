import type { AdapterStep, FieldKey, UploadState } from '../../apply-types'
import { atsForHost } from '../../apply-url'
import { headingText, SUBMITTED } from './text'
import type { Adapter, UploadProbe } from './types'

/**
 * Workday (`<tenant>.wd<N>.myworkdayjobs.com`, `*.myworkdaysite.com`): a
 * client-rendered, multi-step flow. Posting ("Apply") → choice ("Autofill
 * with Resume" / "Apply Manually") → sign-in or create-account wall → steps
 * under a progress bar (My Information, My Experience, …). Inside the flow
 * the URL often stays the same, so the step comes from the active progress
 * step's title.
 *
 * Only the My Information and resume steps are `form`; everything else is
 * the user's (the panel says which button to press). The account wall is
 * never filled: not the email, never a password, never the `beecatcher`
 * honeypot. Huntgry never presses Apply, Next, Sign In or Create Account.
 *
 * Selectors: the posting, choice and account-wall ids were captured live on
 * 2026-10-03. The steps after sign-in come from open-source Workday autofill
 * code (see fixtures/workday-my-information.html) and cover both the older
 * `legalNameSection_*` and the newer `formField-legalName--*` markup.
 */

const aid = (id: string) => `[data-automation-id="${id}"]`
const any = (...ids: string[]) => ids.map(aid).join(', ')

/** Markup only Workday's apply flow has (local mocks and custom domains are recognised by it). */
const MARKERS = any('applyFlowPage', 'applyAdventurePage', 'adventureButton', 'signInContent', 'jobPostingPage')
/** The progress bar's labels: "current step 2 of 6" (screen-reader text) and the title "My Information". */
const ACTIVE_STEP = `ol${aid('progressBar')} li${aid('progressBarActiveStep')}`
const STEP_COUNTER = /^(current )?step \d+ of \d+$/i

/** The sign-in / create-account wall, or any page asking for a password. */
const ACCOUNT_WALL = [
  any('signInContent', 'signInFormo', 'formField-password', 'formField-verifyPassword', 'createAccountSubmitButton', 'signInSubmitButton'),
  'input[type="password"]'
].join(', ')
const CHOICE = any('applyAdventurePage', 'autofillWithResume', 'applyManually')
const MY_INFORMATION = any(
  'applyFlowMyInfoPage',
  'legalNameSection_firstName',
  'formField-legalNameSection_firstName',
  'formField-legalName--firstName'
)
const RESUME = any('file-upload-input-ref', 'file-upload-drop-zone', 'file-upload-successful')
const FORM_TITLES = /my information|my experience|resume|cv\b/i

/** The uploaded-file list Workday shows once it has the file (and, on Autofill with Resume, has parsed it). */
const UPLOADED = any('file-upload-successful', 'file-upload-item')
/** Upload in progress, inside the resume widget. */
const UPLOADING = [any('file-upload-in-progress', 'file-upload-uploading'), '[role="progressbar"]'].join(', ')
/** Workday busy: loading the next step, or reading the resume on "Autofill with Resume" (it then rewrites My Information). */
const BUSY = any('loadingSpinner', 'resumeParsing')

/** The active progress step's title ("My Information"), without the "current step 2 of 6" counter. */
function activeStepTitle(doc: Document): string | null {
  const step = doc.querySelector(ACTIVE_STEP)
  if (!step) return null
  const labels = Array.from(step.querySelectorAll('label'))
    .map((l) => (l.textContent ?? '').trim())
    .filter((t) => t && !STEP_COUNTER.test(t))
  return labels.at(-1) ?? null
}

function step(doc: Document): AdapterStep {
  if (doc.querySelector(ACCOUNT_WALL)) return 'account-wall'
  if (doc.querySelector(CHOICE)) return 'choice'
  if (doc.querySelector(aid('adventureButton')) && !doc.querySelector(aid('progressBar'))) return 'posting'
  if (doc.querySelector(MY_INFORMATION) || doc.querySelector(RESUME)) return 'form'
  const title = activeStepTitle(doc)
  if (title && FORM_TITLES.test(title)) return 'form'
  return 'other'
}

function stepTitle(doc: Document): string | null {
  const title = activeStepTitle(doc)
  if (title) return title
  if (doc.querySelector(CHOICE)) return 'Start Your Application'
  if (doc.querySelector(aid('adventureButton'))) return 'Job posting'
  return null
}

/** Inputs by their own `data-automation-id`, by the field wrapper's, and by the newer tenants' ids. */
const KNOWN: ReadonlyArray<readonly [string, FieldKey]> = [
  [`input${aid('legalNameSection_firstName')}`, 'firstName'],
  [`${aid('formField-legalNameSection_firstName')} input`, 'firstName'],
  [`${aid('formField-legalName--firstName')} input`, 'firstName'],
  ['input[id="name--legalName--firstName"]', 'firstName'],
  [`input${aid('legalNameSection_lastName')}`, 'lastName'],
  [`${aid('formField-legalNameSection_lastName')} input`, 'lastName'],
  [`${aid('formField-legalName--lastName')} input`, 'lastName'],
  ['input[id="name--legalName--lastName"]', 'lastName'],
  [`input${aid('email')}`, 'email'],
  [`${aid('formField-email')} input`, 'email'],
  ['input[id="emailAddress--emailAddress"]', 'email'],
  [`input${aid('phone-number')}`, 'phone'],
  [`input${aid('phone')}`, 'phone'],
  [`${aid('formField-phone-number')} input`, 'phone'],
  [`${aid('formField-phoneNumber')} input`, 'phone'],
  ['input[id="phoneNumber--phoneNumber"]', 'phone'],
  [`input${aid('addressSection_city')}`, 'location'],
  [`${aid('formField-addressSection_city')} input`, 'location'],
  [`${aid('formField-city')} input`, 'location'],
  ['input[id="address--city"]', 'location'],
  [`input${aid('linkedinQuestion')}`, 'linkedin'],
  [`${aid('formField-linkedinQuestion')} input`, 'linkedin'],
  [`input${aid('websiteQuestion')}`, 'website'],
  [`${aid('formField-websiteQuestion')} input`, 'website'],
  [`input[type="file"]${aid('file-upload-input-ref')}`, 'resume']
]

/** Whether `item` names exactly `name`: an element whose own text is the file name (not `old-resume.pdf`). */
function namesFile(item: Element, name: string): boolean {
  return [item, ...Array.from(item.querySelectorAll('*'))].some(
    (el) => el.children.length === 0 && (el.textContent ?? '').trim().toLowerCase() === name
  )
}

/**
 * The file is attached once the resume widget (the group remembered at fill
 * time; the document only when there is none) lists exactly this file name.
 * Another section's upload, or an older file whose name merely contains it,
 * does not count.
 */
function uploadAttached({ doc, input, group, fileName }: UploadProbe): UploadState {
  const name = fileName.trim().toLowerCase()
  const scope: ParentNode = group ?? doc
  const items = Array.from(scope.querySelectorAll(UPLOADED))
  if (items.some((el) => namesFile(el, name))) return 'attached'
  if (scope.querySelector(UPLOADING)) return 'pending'
  // The input took the file but the widget has not caught up yet.
  if (input?.files && Array.from(input.files).some((f) => f.name.toLowerCase() === name)) return 'pending'
  return 'missing'
}

export const workday: Adapter = {
  ats: 'workday',
  matches: (url, doc) => atsForHost(url.hostname) === 'workday' || doc.querySelector(MARKERS) !== null,
  formRoot: (doc) => doc.querySelector(aid('applyFlowPage')) ?? doc.querySelector('main') ?? doc.body,
  known: KNOWN,
  // A React app: its radios ("previously worked here") and checkboxes only take a click (#71: suggested, never set).
  clickOnly: ['input[type="radio"]', 'input[type="checkbox"]'],
  isConfirmation: (_url, doc) =>
    !doc.querySelector(ACTIVE_STEP) && !doc.querySelector(RESUME) && SUBMITTED.test(headingText(doc)),
  ready: (doc) => doc.querySelector(MARKERS) !== null && doc.querySelector(BUSY) === null,
  step,
  stepTitle,
  uploadGroup: (input) => input.closest(aid('file-upload-drop-zone'))?.parentElement ?? null,
  uploadAttached,
  // On "Autofill with Resume" Workday parses the file before it lists it as uploaded.
  afterUpload: { waitFor: aid('file-upload-successful'), timeoutMs: 20_000 }
}
