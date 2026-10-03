import { ipcRenderer } from 'electron'
import type { FillReport, FillValues } from '@shared/apply-types'
import { AUTOFILL_CHANNELS } from '@shared/autofill-channels'
import { currentAdapter, detectConfirmation, fillPage, scanPage, uploadStateOf, verifyFill } from '@shared/autofill/engine'
import { anyShown, sleep, waitForReady, waitUntil } from '@shared/autofill/ready'

/**
 * Preload of every in-app browser tab (#24 auto-apply). It runs in an isolated
 * world: the page's own scripts can neither see nor call it, and nothing is
 * exposed to them (no contextBridge). It only answers main:
 * - `detect` waits for the page to be ready, then scans it;
 * - `fill` fills it, waits a moment and verifies the values held (#63: React
 *   hydration resets a form filled too early), never submits;
 * - `uploadState` waits for the site's upload widget to show a file main attached;
 * - `afterUpload` waits for the site's resume parser, then verifies again.
 * After a detect it watches the page for the site's "application submitted"
 * view and, while no form is found, for a form or embedded form that renders late.
 */

interface Request {
  requestId: string
  values?: FillValues
  text?: boolean
  key?: 'resume' | 'coverLetter'
  fileName?: string
  timeoutMs?: number
}

/** How long after a fill the values are checked again (hydration and late re-renders). */
const VERIFY_AFTER_MS = 1000
/** How long a page without a form is watched for one (a late iframe, a client-rendered form). */
const WATCH_FORM_MS = 20_000

let watching = false
let confirmed = false
let watchingForm = false
/** The last fill on this page, for the verify after an upload. */
let lastReport: FillReport | null = null

function watchForConfirmation(): void {
  if (watching || confirmed) return
  watching = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    timer = undefined
    if (confirmed || !detectConfirmation(document)) return
    confirmed = true
    observer.disconnect()
    ipcRenderer.send(AUTOFILL_CHANNELS.confirmation, { url: location.href })
  }
  const observer = new MutationObserver(() => {
    timer ??= setTimeout(check, 400)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('popstate', check)
  window.addEventListener('hashchange', check)
}

/** Tells main once when a form or an embedded form shows up on a page that had none. */
function watchForForm(): void {
  if (watchingForm) return
  watchingForm = true
  void waitUntil(
    document,
    () => {
      const scan = scanPage(document)
      return scan.formFound || scan.embedUrl !== null
    },
    WATCH_FORM_MS
  ).then((found) => {
    if (found) ipcRenderer.send(AUTOFILL_CHANNELS.formAppeared, { url: location.href })
  })
}

function reply(requestId: string, run: () => Promise<unknown>): void {
  run().then(
    (result) => ipcRenderer.send(AUTOFILL_CHANNELS.result, { requestId, ok: true, result }),
    (err: unknown) =>
      ipcRenderer.send(AUTOFILL_CHANNELS.result, { requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  )
}

const ready = (maxMs?: number) => waitForReady(document, () => currentAdapter(document), { maxMs })

// Tabs run with nodeIntegrationInSubFrames off, so this preload exists in the top frame only; iframes (ads,
// widgets) never answer. An embedded ATS form is opened directly by main instead.
ipcRenderer.on(AUTOFILL_CHANNELS.detect, (_e, req: Request) => {
  reply(req.requestId, async () => {
    await ready()
    const scan = scanPage(document)
    if (!scan.confirmation) watchForConfirmation()
    if (!scan.formFound) watchForForm()
    return scan
  })
})

ipcRenderer.on(AUTOFILL_CHANNELS.fill, (_e, req: Request) => {
  reply(req.requestId, async () => {
    const values = req.values
    if (!values) throw new Error('No values to fill.')
    await ready(3000)
    const report = fillPage(document, values, { text: req.text })
    if (report.fields.some((f) => f.outcome === 'filled')) {
      await sleep(document, VERIFY_AFTER_MS)
      verifyFill(document, values, report)
    }
    lastReport = report
    return report
  })
})

ipcRenderer.on(AUTOFILL_CHANNELS.uploadState, (_e, req: Request) => {
  reply(req.requestId, async () => {
    const key = req.key === 'coverLetter' ? 'coverLetter' : 'resume'
    const fileName = typeof req.fileName === 'string' ? req.fileName : ''
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 8000, 0), 30_000)
    await waitUntil(document, () => uploadStateOf(document, key, fileName) === 'attached', timeoutMs)
    return uploadStateOf(document, key, fileName)
  })
})

ipcRenderer.on(AUTOFILL_CHANNELS.afterUpload, (_e, req: Request) => {
  reply(req.requestId, async () => {
    const values = req.values
    if (!values) throw new Error('No values to fill.')
    const after = currentAdapter(document).afterUpload
    if (after) await waitUntil(document, () => anyShown(document, after.waitFor), after.timeoutMs)
    if (!lastReport) return null
    // The parser fills empty fields a moment after it reports success.
    await sleep(document, 300)
    return verifyFill(document, values, lastReport)
  })
})
