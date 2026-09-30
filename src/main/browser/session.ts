import { app, session, type Session, type WebContents } from 'electron'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { localUrlsAllowed, loopbackOnly } from '../cli/dev-urls'
import { createRequestGuard, GUARDED_URLS } from '../cli/public-host'

/**
 * The embedded browser's cookie jar: a persistent partition of its own (not
 * shared with the hidden job-board loader), hardened like it. Persistent so a
 * login or a solved human check survives restarts, and because extensions
 * (#24) can only be loaded into persistent sessions.
 */
export const BROWSER_PARTITION = 'persist:huntgry-browser'

/** Folder whose unpacked extensions are loaded into the browser session (the #24 auto-apply hook). */
export const extensionsDir = (): string => join(app.getPath('userData'), 'browser-extensions')

let configured: Session | null = null
let onDownloadRefused: (contents: WebContents) => void = () => undefined

/** Called with the page's `webContents` whenever a download is refused, so its tab can say so. */
export function setDownloadRefusedHandler(handler: (contents: WebContents) => void): void {
  onDownloadRefused = handler
}

/** The browser session, configured once. */
export function browserSession(): Session {
  if (configured) return configured
  const s = session.fromPartition(BROWSER_PARTITION)
  // Job postings never need the camera, notifications, location, MIDI…; Electron grants them by default.
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.setPermissionCheckHandler(() => false)
  // v1: no downloads (a posting PDF would otherwise land somewhere silently); the tab offers the system browser.
  s.on('will-download', (event, _item, contents) => {
    event.preventDefault()
    onDownloadRefused(contents)
  })
  // Same SSRF guard as the job-board loader: no page, redirect or subresource may reach localhost or the private network
  // (except loopback in a dev build started with HUNTGRY_ALLOW_LOCAL_URLS=1, for the mock ATS of #24).
  s.webRequest.onBeforeRequest(
    { urls: GUARDED_URLS },
    createRequestGuard(localUrlsAllowed(app.isPackaged), undefined, loopbackOnly(app.isPackaged))
  )
  configured = s
  void loadExtensions(s)
  return s
}

/**
 * Loads each unpacked extension in `<userData>/browser-extensions/<name>/`.
 * Nothing ships there today; #24 (auto-apply) can drop a content-script
 * extension in. Electron requires re-loading extensions on every launch.
 */
async function loadExtensions(s: Session): Promise<void> {
  const dir = extensionsDir()
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    await s.extensions
      .loadExtension(join(dir, entry.name))
      .catch((err: unknown) => console.error(`Loading browser extension ${entry.name} failed:`, err))
  }
}
