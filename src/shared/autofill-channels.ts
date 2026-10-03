/**
 * Main ↔ guest-page messages (the browser tab's preload, never the app's
 * renderer). Main sends `detect` / `fill` / `uploadState` / `afterUpload`
 * with a request id; the page answers on `result`. Once per page it sends
 * `confirmation` when the site's "application submitted" page appears after a
 * detect, and `formAppeared` when a form (or an embedded form) renders after
 * a detect found none. `step` is sent whenever a multi-step site (Workday)
 * moves to another step, renders more of it or finishes being busy, without
 * a navigation.
 */
export const AUTOFILL_CHANNELS = {
  detect: 'huntgry:autofill:detect',
  fill: 'huntgry:autofill:fill',
  uploadState: 'huntgry:autofill:upload-state',
  afterUpload: 'huntgry:autofill:after-upload',
  result: 'huntgry:autofill:result',
  confirmation: 'huntgry:autofill:confirmation',
  formAppeared: 'huntgry:autofill:form-appeared',
  step: 'huntgry:autofill:step'
} as const

/** Attribute the page script puts on a file input so main can find it over CDP. */
export const UPLOAD_ATTR = 'data-huntgry-upload'

/** Attribute on the input's upload widget, which outlives the input on sites that remove it (Greenhouse). */
export const UPLOAD_GROUP_ATTR = 'data-huntgry-upload-group'
