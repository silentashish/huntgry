import { atsForHost } from '../../apply-url'
import { headingText, SUBMITTED } from './text'
import type { Adapter } from './types'

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
