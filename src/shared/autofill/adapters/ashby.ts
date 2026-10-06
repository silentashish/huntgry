import { atsForHost } from '../../apply-url'
import type { UploadState } from '../../apply-types'
import { headingText, SUBMITTED } from './text'
import type { Adapter, UploadProbe } from './types'

/**
 * Ashby (`jobs.ashbyhq.com/<org>/<id>/application`, verified on live markup
 * 2026-10-03). A client-rendered React app: there is no `<form>`, the fields
 * appear 0.4-0.7 s after `load`, and phone and links are custom questions
 * with UUID ids (matched by their label).
 *
 * The page has two file inputs. The "Autofill from resume" pane
 * (`.ashby-application-form-autofill-uploader`) parses the file and
 * overwrites fields, so it is outside the form root and never touched. The
 * real resume field is `#_systemfield_resume`; Ashby uploads it on `change`
 * (`ApiCreateFileUploadHandle`) and then lists the file name with a delete
 * button, and its button turns into "Replace".
 */

const CONTAINER = '.ashby-application-form-container'
const FILE_WIDGET = '.ashby-application-form-input-file'
const FILE_ITEM = '.ashby-application-form-input-file-item'
const FILE_NAME = '.ashby-application-form-input-file-item-name'
const FILE_DELETE = '.ashby-application-form-input-file-item-delete'
const SUCCESS = '.ashby-application-form-success-container'

/** Ashby's own markup: the form container, a system field, or the "submitted" panel. */
const MARKUP = `${CONTAINER}, #_systemfield_name, #_systemfield_email, ${SUCCESS}`

export const ashby: Adapter = {
  ats: 'ashby',
  matches: (url, doc) => atsForHost(url.hostname) === 'ashby' || doc.querySelector(MARKUP) !== null,
  // The container holds every question but not the autofill pane above it.
  formRoot: (doc) =>
    doc.querySelector(CONTAINER) ??
    doc.querySelector('#_systemfield_name')?.closest('#form, [class*="application-form"]') ??
    null,
  known: [
    ['#_systemfield_name', 'fullName'],
    ['#_systemfield_email', 'email'],
    [`input[type="file"]#_systemfield_resume`, 'resume']
  ],
  isConfirmation: (_url, doc) =>
    doc.querySelector(SUCCESS) !== null || (doc.querySelector(CONTAINER) === null && SUBMITTED.test(headingText(doc))),

  // Location ("Where are you currently located?", labelled for `_systemfield_location` but an id-less
  // autocomplete) and dates are pickers: the user's choice.
  choices: ['.ashby-application-form-input-autocomplete', '.ashby-application-form-input-date'],
  // React radios and the yes/no buttons' hidden checkboxes only take a click (React's change event for them
  // listens to `click`): remembered answers are suggested in the panel, never set (#71).
  clickOnly: ['input[type="radio"]', 'input[type="checkbox"]'],
  // The voluntary EEO survey is a second `.ashby-application-form-container` inside `.ashby-survey-form-container`.
  answerRoots: (doc) => Array.from(doc.querySelectorAll('.ashby-survey-form-container')),

  // Client-rendered: ready once React has rendered the system fields.
  ready: (doc) => doc.querySelector(`${CONTAINER} #_systemfield_name, ${CONTAINER} #_systemfield_email`) !== null,

  // The resume field does not run the parser, but its upload re-renders the widget: attach first, then fill
  // only what is still empty (values Ashby's own autofill or the user put in are kept).
  uploadOrder: 'files-first',
  uploadGroup: (input) => input.closest(FILE_WIDGET),
  uploadAttached: ashbyUploadState,
  afterUpload: { waitFor: `${FILE_WIDGET} ${FILE_DELETE}`, timeoutMs: 10_000 }
}

/**
 * The widget lists the file by name: with a spinner and no delete button
 * while it uploads (`pending`), with the delete button once Ashby holds it
 * (`attached`). A failed upload shows a toast and lists nothing (`missing`).
 */
export function ashbyUploadState({ doc, input, group, fileName }: UploadProbe): UploadState {
  const widget = (group?.isConnected ? group : null) ?? input?.closest(FILE_WIDGET) ?? doc.querySelector(`#_systemfield_resume`)?.closest(FILE_WIDGET)
  if (!widget) return 'missing'
  const items = Array.from(widget.querySelectorAll(FILE_ITEM))
  const item = items.find((i) => (i.querySelector(FILE_NAME)?.textContent ?? '').trim() === fileName)
  if (!item) return 'missing'
  return item.querySelector(FILE_DELETE) ? 'attached' : 'pending'
}
