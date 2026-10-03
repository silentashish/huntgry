import { ipcRenderer } from 'electron'
import type { FillValues } from '@shared/apply-types'
import { AUTOFILL_CHANNELS } from '@shared/autofill-channels'
import { detectConfirmation } from '@shared/autofill/engine'
import { PageSession, watchForForm } from '@shared/autofill/session'

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

let watching = false
let confirmed = false
let watchingForm = false
/** This document's fill state; user edits are trusted (keyboard, paste) events only. */
const page = new PageSession(document)

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

/** Tells main once when a form or an embedded form shows up on a page that had none (no time limit). */
function watchForLateForm(): void {
  if (watchingForm) return
  watchingForm = true
  watchForForm(document, () => {
    // Re-armed by the next detect that finds no form (e.g. the form was removed again).
    watchingForm = false
    ipcRenderer.send(AUTOFILL_CHANNELS.formAppeared, { url: location.href })
  })
}

function reply(requestId: string, run: () => Promise<unknown>): void {
  run().then(
    (result) => ipcRenderer.send(AUTOFILL_CHANNELS.result, { requestId, ok: true, result }),
    (err: unknown) =>
      ipcRenderer.send(AUTOFILL_CHANNELS.result, { requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  )
}

// Tabs run with nodeIntegrationInSubFrames off, so this preload exists in the top frame only; iframes (ads,
// widgets) never answer. An embedded ATS form is opened directly by main instead.
ipcRenderer.on(AUTOFILL_CHANNELS.detect, (_e, req: Request) => {
  reply(req.requestId, async () => {
    const scan = await page.detect()
    if (!scan.confirmation) watchForConfirmation()
    if (!scan.formFound) watchForLateForm()
    return scan
  })
})

ipcRenderer.on(AUTOFILL_CHANNELS.fill, (_e, req: Request) => {
  reply(req.requestId, async () => {
    if (!req.values) throw new Error('No values to fill.')
    return page.fill(req.values, req.text)
  })
})

ipcRenderer.on(AUTOFILL_CHANNELS.uploadState, (_e, req: Request) => {
  reply(req.requestId, async () => {
    const key = req.key === 'coverLetter' ? 'coverLetter' : 'resume'
    const fileName = typeof req.fileName === 'string' ? req.fileName : ''
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 8000, 0), 30_000)
    return page.uploadState(key, fileName, timeoutMs)
  })
})

ipcRenderer.on(AUTOFILL_CHANNELS.afterUpload, (_e, req: Request) => {
  reply(req.requestId, async () => {
    if (!req.values) throw new Error('No values to fill.')
    return page.afterUpload(req.values)
  })
})
