import type { AdapterStep, ApplyAts, FieldKey, UploadState } from '../../apply-types'

/**
 * The adapter contract: per-ATS knowledge the autofill engine uses. Every
 * adapter lives in its own file under `adapters/` and is listed once in
 * `adapters/index.ts` (most specific first). A new ATS only adds a file, a
 * registry line and its fixtures; the engine, the preload and the apply
 * service read the optional hooks below and fall back to the generic
 * behaviour when an adapter leaves them out.
 *
 * Adapters are pure DOM code: they run in the browser tab's preload (an
 * isolated world, so the page's own JS objects such as React props are not
 * visible) and in jsdom for tests. They must never submit, click or type
 * (guard.test.ts scans this folder).
 */
export interface Adapter {
  ats: ApplyAts
  /** Recognises the site by host, or by its markup so local mocks and custom domains work too. */
  matches(url: URL, doc: Document): boolean
  /** The element holding the application's fields (a `<form>`, or a container on SPA forms without one). */
  formRoot(doc: Document): Element | null
  /** Selector → key, tried inside the form root before the generic matcher. */
  known: ReadonlyArray<readonly [string, FieldKey]>
  /** The site's "application submitted" page. */
  isConfirmation(url: URL, doc: Document): boolean

  /**
   * Selectors of text inputs that are really pickers (autocompletes the site
   * clears on free text, e.g. Lever's location). Reported as a choice for the
   * user, never typed into.
   */
  choices?: readonly string[]

  /**
   * Readiness: whether the form is rendered and the page's framework has
   * taken over its fields. The engine's async `waitForReady` first waits for
   * `load` and a quiet DOM, then polls this (awaiting it when it returns a
   * promise) until it is true or the wait times out. Leave it out when a quiet
   * DOM is enough. Client-rendered forms (Ashby) check for their first field.
   */
  ready?(doc: Document): boolean | Promise<boolean>

  /**
   * Which step of the site's apply flow the page is. Only `form` is filled
   * automatically; the others make the panel tell the user what to do in the
   * page (Huntgry never presses the site's buttons). Default: `form`.
   */
  step?(doc: Document): AdapterStep
  /** A short title of the current step ("My Information"), so a multi-step SPA auto-fills each step once. */
  stepTitle?(doc: Document): string | null

  /**
   * Upload strategy. `text-first` (default) fills text, then attaches files,
   * for sites whose parser only fills empty fields after an upload (Lever).
   * `files-first` attaches first and fills text after `afterUpload`, for
   * sites whose parser would otherwise be skipped or whose upload re-renders
   * the form.
   */
  uploadOrder?: 'text-first' | 'files-first'
  /**
   * The upload widget around a file input. It is remembered before the
   * upload because some sites (Greenhouse) remove the input once a file is
   * chosen. Default: the closest `[role=group]`, `fieldset`, `label` or field
   * wrapper.
   */
  uploadGroup?(input: HTMLInputElement): Element | null
  /**
   * Whether the site's own widget shows the attached file. Default: the
   * input holds a file, or (input removed) the group shows the file name;
   * a progress bar means `pending`.
   */
  uploadAttached?(probe: UploadProbe): UploadState
  /**
   * A parser or upload the site runs after a file is attached: wait until an
   * element matching `waitFor` is shown (not `display: none` / hidden, up to
   * `timeoutMs`), then re-verify the text fields Huntgry filled and restore
   * any the parser changed.
   */
  afterUpload?: { waitFor: string; timeoutMs: number }
}

export interface UploadProbe {
  doc: Document
  /** Which upload this is. */
  kind: 'resume' | 'coverLetter'
  /** The marked file input, or null once the site has removed it. */
  input: HTMLInputElement | null
  /** The upload widget remembered before the upload (see `uploadGroup`). */
  group: Element | null
  /** The attached file's name, e.g. `resume.pdf`. */
  fileName: string
}
