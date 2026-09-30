/**
 * Main ↔ guest-page messages (the browser tab's preload, never the app's
 * renderer). Main sends `detect` / `fill` with a request id; the page answers
 * on `result`, and once per page on `confirmation` when the site's
 * "application submitted" page appears after a detect.
 */
export const AUTOFILL_CHANNELS = {
  detect: 'huntgry:autofill:detect',
  fill: 'huntgry:autofill:fill',
  result: 'huntgry:autofill:result',
  confirmation: 'huntgry:autofill:confirmation'
} as const

/** Attribute the page script puts on a file input so main can find it over CDP. */
export const UPLOAD_ATTR = 'data-huntgry-upload'
