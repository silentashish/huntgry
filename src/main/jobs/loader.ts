import { BrowserWindow, session } from 'electron'
import { assertPublicUrl } from '../cli/public-url'
import { isBlockedPage } from './blocked'

/**
 * Loads a job board page in a hidden browser window and reads data from it.
 * Boards serve their results to real browsers and block plain HTTP clients,
 * so this is the reliable way to read them, and it is what a person does
 * when they open the page. Pages load one at a time, at most one per
 * `MIN_GAP_MS` per host, and only when the user searches.
 */

export type LoadResult =
  { status: 'ok'; data: unknown } | { status: 'blocked'; message: string } | { status: 'error'; message: string }

const PARTITION = 'persist:huntgry-jobboards'
const MIN_GAP_MS = 4000
const EMPTY_GRACE_MS = 8000
const lastLoad = new Map<string, number>()
let queue: Promise<unknown> = Promise.resolve()

let configured: Electron.Session | null = null

/** The job-board session, configured once (it is the same object on every call). */
function configureSession(): Electron.Session {
  if (configured) return configured
  const s = session.fromPartition(PARTITION)
  // The board pages never need camera, notifications or the like, nor downloads.
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.on('will-download', (e) => e.preventDefault())
  // A posting URL is user input: neither it, nor a redirect, nor anything the page requests may reach
  // localhost or the private network (SSRF). Checked per request, cached per host for a minute.
  s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    void isPublicHost(details.url).then((ok) => callback({ cancel: !ok }))
  })
  configured = s
  return s
}

const HOST_CHECK_TTL_MS = 60_000
const hostChecks = new Map<string, { ok: boolean; at: number }>()

/** Whether `url`'s host is public (see `assertPublicUrl`), cached per host. */
async function isPublicHost(url: string): Promise<boolean> {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return false
  }
  const cached = hostChecks.get(host)
  if (cached && Date.now() - cached.at < HOST_CHECK_TTL_MS) return cached.ok
  // WebSocket URLs are checked as their http(s) equivalent.
  const ok = await assertPublicUrl(url.replace(/^ws/i, 'http')).then(
    () => true,
    () => false
  )
  hostChecks.set(host, { ok, at: Date.now() })
  return ok
}

/**
 * Opens `url`, then evaluates `extract` (an expression returning a JSON string,
 * or `null` while the data is not there yet) every second until it returns
 * data, a bot wall is detected, or `timeoutMs` passes. Data marked
 * `empty: true` is provisional: pages often render an empty list before the
 * results arrive, so it is only accepted after `EMPTY_GRACE_MS`.
 */
export function loadAndExtract(url: string, extract: string, timeoutMs = 25000): Promise<LoadResult> {
  const run = queue.then(() => load(url, extract, timeoutMs))
  queue = run.catch(() => undefined)
  return run
}

async function load(url: string, extract: string, timeoutMs: number): Promise<LoadResult> {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      return { status: 'error', message: 'Only http(s) URLs can be loaded.' }
    host = u.host
  } catch {
    return { status: 'error', message: 'Not a valid URL.' }
  }
  try {
    await assertPublicUrl(url)
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  const wait = (lastLoad.get(host) ?? 0) + MIN_GAP_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastLoad.set(host, Date.now())

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: configureSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true
    }
  })
  // Pages must not open popups or download files.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let status: number | null = null
  win.webContents.on('did-navigate', (_e, _url, code) => {
    status = code
  })
  try {
    win.loadURL(url).catch(() => undefined)
    const started = Date.now()
    const deadline = started + timeoutMs
    let lastPage = { title: '', text: '' }
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      if (win.isDestroyed()) return { status: 'error', message: 'The page closed.' }
      lastPage = await win.webContents
        .executeJavaScript(
          '({ title: document.title, text: document.body ? document.body.innerText.slice(0, 3000) : "" })',
          true
        )
        .catch(() => lastPage)
      // Never read data from a bot wall (a generic extract would happily return its text).
      if (isBlockedPage({ ...lastPage, status })) {
        // A challenge page may clear itself after a few seconds; only give up on it later.
        if (Date.now() > deadline - timeoutMs / 2) {
          return {
            status: 'blocked',
            message: `${host} asked for a human check (${lastPage.title || `HTTP ${status}`}).`
          }
        }
        continue
      }
      const raw = await win.webContents.executeJavaScript(extract, true).catch(() => null)
      if (typeof raw === 'string' && raw) {
        try {
          const data: unknown = JSON.parse(raw)
          const empty = typeof data === 'object' && data !== null && (data as { empty?: unknown }).empty === true
          if (!empty || Date.now() - started > EMPTY_GRACE_MS) return { status: 'ok', data }
        } catch {
          // keep polling
        }
      }
    }
    return isBlockedPage({ ...lastPage, status })
      ? { status: 'blocked', message: `${host} asked for a human check (${lastPage.title || `HTTP ${status}`}).` }
      : { status: 'error', message: `${host} did not return job data in time.` }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
