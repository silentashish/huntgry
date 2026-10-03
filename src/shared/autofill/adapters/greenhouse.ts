import { atsForHost } from '../../apply-url'
import { headingText, SUBMITTED } from './text'
import type { Adapter } from './types'

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
