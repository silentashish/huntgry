import type { PageAnswers } from '../apply-facts'
import type { FillProfile, FillReport, FillValues, PageScan, UploadState } from '../apply-types'
import { currentAdapter, embedUrlsOf, fillPage, fillSections, pendingPicks, pickAnswers, scanPage, uploadStateOf, verifyFill, type UploadKey } from './engine'
import { isConsentQuestion, normalizeText } from '../apply-facts'
import { chosenOf } from './dom'
import { controlOf, editedInGroup } from './answers'
import { pickedValue, widgetOf } from './pick'
import { anyShown, sleep, waitForReady, waitUntil } from './ready'
import { watchUserEdits, type UserEditOptions } from './user-edits'

/** A question the person answered or corrected in the page (#136), reported to main to remember. */
export interface PageEdit {
  fieldId: string
  value: string
}

/** Longest edit reported (main checks it again). */
const MAX_EDIT_CHARS = 500

/**
 * The questions of `report` the person changed in the page, with the value each shows now (#136). A typed field,
 * native select or radio group counts once the person edited it (user-edits.ts). A widget that only takes a click
 * (react-select, Workday's dropdown, Ashby's buttons) counts when it shows an answer other than what the fill left
 * there, for a line that was not already answered before the fill (`kept`). Consent questions are never reported.
 */
export function editsOf(report: FillReport | null): PageEdit[] {
  if (!report) return []
  const out = new Map<string, string>()
  for (const line of report.fields) {
    if (!line.fieldId || !line.question || isConsentQuestion(line.label)) continue
    const control = controlOf(line)
    if (!control) continue
    const { el, root, clickOnly } = control
    let value = ''
    if (clickOnly) {
      const widget = widgetOf(el)
      value = widget ? pickedValue(widget).trim() : ''
      const left = line.outcome === 'filled' ? (line.value ?? '') : ''
      if (line.outcome === 'kept' || !value || normalizeText(value) === normalizeText(left)) continue
    } else {
      if (!editedInGroup(el, line.kind, root)) continue
      value = chosenOf(el, root).trim()
    }
    if (value && value.length <= MAX_EDIT_CHARS) out.set(line.fieldId, value)
  }
  return [...out].map(([fieldId, value]) => ({ fieldId, value }))
}

/**
 * What the tab's preload does for main, on one document, kept here (pure DOM)
 * so jsdom tests drive the same code. The preload creates one per page load.
 */

export interface PageSessionOptions extends UserEditOptions {
  /** How long after a fill the values are checked again (hydration and late re-renders). */
  verifyAfterMs?: number
  /** How long a value written again must hold before it counts. */
  settleMs?: number
  /** Readiness waits (see ready.ts). */
  quietMs?: number
  readyMaxMs?: number
}

export class PageSession {
  /** The last fill that wrote text, for the verify after an upload. */
  private lastReport: FillReport | null = null

  constructor(
    readonly doc: Document,
    private readonly opts: PageSessionOptions = {}
  ) {
    watchUserEdits(doc, opts)
  }

  private ready(maxMs = this.opts.readyMaxMs): Promise<boolean> {
    return waitForReady(this.doc, () => currentAdapter(this.doc), { quietMs: this.opts.quietMs, maxMs })
  }

  private get url(): string {
    return this.doc.location?.href ?? this.doc.URL
  }

  async detect(): Promise<PageScan> {
    await this.ready()
    return scanPage(this.doc)
  }

  /**
   * Fills (or with `text: false` only re-marks the file inputs), then verifies.
   * A marker-only pass (an upload retry) never replaces the text report that
   * the verify after the upload works from. `answers` are the remembered
   * application answers (#71); with `pick`, trusted ones are also picked in
   * widgets that only take a click (pick.ts). `profile` (#136) fills the
   * repeatable sections (Workday My Experience) before the picks.
   */
  async fill(values: FillValues, text?: boolean, answers?: PageAnswers, pick?: boolean, profile?: FillProfile): Promise<FillReport> {
    const url = this.url
    await this.ready(Math.min(this.opts.readyMaxMs ?? 3000, 3000))
    // A single-page app moved on while it settled: this fill was for the previous view.
    if (this.url !== url) throw new Error('The page changed before it could be filled.')
    const report = fillPage(this.doc, values, { text, answers, pick, profile })
    await fillSections(report)
    if (pendingPicks(report).length > 0) await pickAnswers(report)
    if (report.fields.some((f) => f.outcome === 'filled')) {
      await sleep(this.doc, this.opts.verifyAfterMs ?? 1000)
      await verifyFill(this.doc, values, report, { settleMs: this.opts.settleMs })
    }
    if (text !== false) this.lastReport = report
    return report
  }

  /** The questions of the last fill the person changed in the page (#136), for main to remember. */
  edits(): PageEdit[] {
    return editsOf(this.lastReport)
  }

  /** The URL of the page the last fill reported (edits are filed against it). */
  get reportUrl(): string | null {
    return this.lastReport?.url ?? null
  }

  /** Waits (up to `timeoutMs`) for the site's widget to show the file main attached. */
  async uploadState(key: UploadKey, fileName: string, timeoutMs: number): Promise<UploadState> {
    await waitUntil(this.doc, () => uploadStateOf(this.doc, key, fileName) === 'attached', timeoutMs)
    return uploadStateOf(this.doc, key, fileName)
  }

  /** Waits for the site's parser (the adapter's `afterUpload`), then verifies the last text fill again. */
  async afterUpload(values: FillValues): Promise<FillReport | null> {
    const after = currentAdapter(this.doc).afterUpload
    if (after) await waitUntil(this.doc, () => anyShown(this.doc, after.waitFor), after.timeoutMs)
    if (!this.lastReport) return null
    // The parser fills empty fields a moment after it reports success.
    await sleep(this.doc, 300)
    return verifyFill(this.doc, values, this.lastReport, { settleMs: this.opts.settleMs })
  }
}

/**
 * Calls `onFound` once a form or an embedded form shows up on a page that had
 * none (a late iframe, a client-rendered form, an Apply button that reveals
 * the form). No time limit: the person may read the posting for minutes
 * before pressing Apply. Checks are throttled to DOM changes. An embed that
 * was already on the page when the watch started does not count: main has
 * already followed or refused it (an untrusted page), and reporting it again
 * on every DOM change would loop detects forever. Returns `stop`.
 */
export function watchForForm(doc: Document, onFound: () => void, { throttleMs = 500 } = {}): () => void {
  const view = doc.defaultView
  if (!view) return () => undefined
  const known = new Set(embedUrlsOf(doc))
  let timer = 0
  let stopped = false
  const stop = () => {
    stopped = true
    observer.disconnect()
    view.clearTimeout(timer)
  }
  const check = () => {
    timer = 0
    if (stopped) return
    const scan = scanPage(doc)
    if (scan.formFound || embedUrlsOf(doc).some((url) => !known.has(url))) {
      stop()
      onFound()
    }
  }
  const observer = new view.MutationObserver(() => {
    if (!timer && !stopped) timer = view.setTimeout(check, throttleMs)
  })
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  return stop
}
