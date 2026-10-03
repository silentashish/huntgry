import { atsForHost } from '../../apply-url'
import { widgetState } from '../upload-state'
import { headingText, SUBMITTED } from './text'
import type { Adapter } from './types'

/** The upload widget ids Greenhouse labels each file field with. */
const GROUP_LABEL = { resume: 'upload-label-resume', coverLetter: 'upload-label-cover_letter' } as const

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
    (doc.querySelector('#application-form, #application_form') === null && SUBMITTED.test(headingText(doc))),
  // "Location (City)" is a react-select that only takes one of its suggestions (captured 2026-10-03).
  choices: ['#candidate-location'],
  // On `change` the board uploads the file to S3 and replaces the <input> with a progress bar, then the file name
  // (captured 2026-10-03). Only that widget counts: an <input> that merely holds the file (the handler never ran,
  // e.g. before hydration) is not attached. The widget is found by its label id too, in case a re-render replaced it.
  uploadAttached: (probe) =>
    widgetState(
      probe.group?.isConnected === true
        ? probe.group
        : probe.doc.querySelector(`[role="group"][aria-labelledby="${GROUP_LABEL[probe.kind]}"]`),
      probe.fileName
    )
}
