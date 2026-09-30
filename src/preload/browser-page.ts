import { ipcRenderer } from 'electron'
import type { FillValues } from '@shared/apply-types'
import { AUTOFILL_CHANNELS } from '@shared/autofill-channels'
import { detectConfirmation, fillPage, scanPage } from '@shared/autofill/engine'

/**
 * Preload of every in-app browser tab (#24 auto-apply). It runs in an isolated
 * world: the page's own scripts can neither see nor call it, and nothing is
 * exposed to them (no contextBridge). It only answers main: `detect` scans the
 * page, `fill` fills it (never submits, see src/shared/autofill/engine.ts).
 * After a detect it watches the page once for the site's "application
 * submitted" view (single-page forms swap it in without a navigation).
 */

interface Request {
  requestId: string
  values?: FillValues
}

let watching = false
let confirmed = false

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

function reply(requestId: string, run: () => unknown): void {
  try {
    ipcRenderer.send(AUTOFILL_CHANNELS.result, { requestId, ok: true, result: run() })
  } catch (err) {
    ipcRenderer.send(AUTOFILL_CHANNELS.result, { requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

// Tabs run with nodeIntegrationInSubFrames off, so this preload exists in the top frame only; iframes (ads,
// widgets) never answer. Greenhouse's embedded form is opened directly by main instead.
ipcRenderer.on(AUTOFILL_CHANNELS.detect, (_e, req: Request) => {
  reply(req.requestId, () => {
    const scan = scanPage(document)
    if (!scan.confirmation) watchForConfirmation()
    return scan
  })
})
ipcRenderer.on(AUTOFILL_CHANNELS.fill, (_e, req: Request) => {
  reply(req.requestId, () => {
    if (!req.values) throw new Error('No values to fill.')
    return fillPage(document, req.values)
  })
})
