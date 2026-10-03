import { atsForHost } from '../../apply-url'
import { anyShown } from '../ready'
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
    ['input[name="org"]', 'currentCompany'],
    ['input[name="urls[LinkedIn]"]', 'linkedin'],
    ['input[name="urls[GitHub]"]', 'github'],
    ['input[name="urls[Portfolio]"]', 'website'],
    ['input[type="file"][name="resume"]', 'resume']
  ],
  isConfirmation: (url, doc) =>
    /\/thanks\/?$/.test(url.pathname) ||
    doc.querySelector('[data-qa="msg-submit-success"]') !== null ||
    (doc.querySelector('#application-form') === null && SUBMITTED.test(headingText(doc))),
  // "Current location" is an autocomplete that clears free text unless a suggestion is picked (live 2026-10-03).
  choices: ['#location-input', 'input[name="location"]'],
  // On `change` Lever posts the file to /parseResume ("Analyzing resume..."), shows the file name in `.filename`,
  // then "Success!" or "Couldn't auto-read resume." and fills empty contact fields from the parse.
  // Only the widget counts (the file name in `.filename`), never the <input> holding a file: CDP sets that even when
  // Lever's handler did not take it.
  uploadAttached: (probe) => {
    const widget = probe.input?.closest('.application-question') ?? probe.group ?? probe.doc.querySelector('.application-question.resume')
    if (anyShown(probe.doc, '.resume-upload-working')) return 'pending'
    if (widget && (widget.querySelector('.filename')?.textContent ?? '').includes(probe.fileName)) return 'attached'
    return 'missing'
  },
  afterUpload: { waitFor: '.resume-upload-success, .resume-upload-failure', timeoutMs: 10_000 }
}
