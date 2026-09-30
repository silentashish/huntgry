import type { ApplyAts, FieldKey } from '../apply-types'
import { atsForHost } from '../apply-url'

/**
 * Per-ATS knowledge: how to recognise the site (by host, or by its markup so
 * local mock pages and custom domains work too), where the form is, the
 * fields with stable ids/names, and its "application submitted" page.
 * Everything not listed here goes through the generic matcher.
 */
export interface Adapter {
  ats: ApplyAts
  matches(url: URL, doc: Document): boolean
  formRoot(doc: Document): Element | null
  /** Selector → key, tried inside the form root. */
  known: ReadonlyArray<readonly [string, FieldKey]>
  isConfirmation(url: URL, doc: Document): boolean
}

const headingText = (doc: Document) =>
  Array.from(doc.querySelectorAll('h1, h2, h3, [role="alert"], [data-qa="msg-submit-success"]'))
    .map((h) => h.textContent ?? '')
    .join('\n')

/** Headings sites show after a submitted application ("thanks for your interest" alone does not count). */
const SUBMITTED =
  /thank(s| you)\b[^.!\n]{0,40}\b(for )?(applying|your application|submitting)|application (was |has been )?(submitted|received|sent)|we('ve| have) received your application/i

/** Greenhouse job boards (verified live 2026-09-29) and the older boards.greenhouse.io form. */
export const greenhouse: Adapter = {
  ats: 'greenhouse',
  matches: (url, doc) =>
    atsForHost(url.hostname) === 'greenhouse' ||
    doc.querySelector('#application-form #first_name, #application_form #first_name') !== null ||
    doc.getElementById('application_confirmation') !== null,
  formRoot: (doc) => doc.querySelector('#application-form, #application_form') ?? doc.querySelector('form'),
  known: [
    ['#first_name', 'firstName'],
    ['#last_name', 'lastName'],
    ['#email', 'email'],
    ['#phone', 'phone'],
    ['input[type="file"]#resume', 'resume'],
    ['input[type="file"]#cover_letter', 'coverLetter'],
    ['#job_application_first_name', 'firstName'],
    ['#job_application_last_name', 'lastName'],
    ['#job_application_email', 'email'],
    ['#job_application_phone', 'phone']
  ],
  isConfirmation: (url, doc) =>
    doc.getElementById('application_confirmation') !== null ||
    /\/confirmation\/?$/.test(url.pathname) ||
    (doc.querySelector('#application-form, #application_form') === null && SUBMITTED.test(headingText(doc)))
}

/** Lever's server-rendered form on `jobs.lever.co/<company>/<id>/apply`. */
export const lever: Adapter = {
  ats: 'lever',
  matches: (url, doc) =>
    atsForHost(url.hostname) === 'lever' ||
    doc.querySelector('input[name="urls[LinkedIn]"], [data-qa="btn-submit"], [data-qa="msg-submit-success"]') !== null,
  formRoot: (doc) => doc.querySelector('#application-form') ?? doc.querySelector('form'),
  known: [
    ['input[name="name"]', 'fullName'],
    ['input[name="email"]', 'email'],
    ['input[name="phone"]', 'phone'],
    ['input[name="location"]', 'location'],
    ['input[name="org"]', 'currentCompany'],
    ['input[name="urls[LinkedIn]"]', 'linkedin'],
    ['input[name="urls[GitHub]"]', 'github'],
    ['input[name="urls[Portfolio]"]', 'website'],
    ['input[type="file"][name="resume"]', 'resume']
  ],
  isConfirmation: (url, doc) =>
    /\/thanks\/?$/.test(url.pathname) ||
    doc.querySelector('[data-qa="msg-submit-success"]') !== null ||
    (doc.querySelector('#application-form') === null && SUBMITTED.test(headingText(doc)))
}

const TEXTISH = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"]'

/** Any other site: the form with a file input, else the one with the most text fields. */
export const generic: Adapter = {
  ats: 'generic',
  matches: () => true,
  formRoot: (doc) => {
    const forms = Array.from(doc.querySelectorAll('form'))
    const withFile = forms.find((f) => f.querySelector('input[type="file"]'))
    if (withFile) return withFile
    const best = forms
      .map((f) => ({ f, n: f.querySelectorAll(TEXTISH).length }))
      .sort((a, b) => b.n - a.n)[0]
    if (best && best.n >= 2) return best.f
    // Client-rendered forms without a <form> element: only when there is an upload field.
    return doc.querySelector('input[type="file"]') ? doc.body : null
  },
  known: [],
  isConfirmation: (_url, doc) => SUBMITTED.test(headingText(doc)) && generic.formRoot(doc) === null
}

/** Most specific first; `generic` always matches. */
export const ADAPTERS: readonly Adapter[] = [greenhouse, lever, generic]

export function adapterFor(url: URL, doc: Document): Adapter {
  return ADAPTERS.find((a) => a.matches(url, doc)) ?? generic
}
