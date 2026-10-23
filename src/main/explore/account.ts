import { app, BrowserWindow } from 'electron'
import type { JobrightAccount } from '@shared/explore-types'
import { currentInspection } from '../current-workspace'
import { configureSession, loadAndExtract, loaderIdle } from '../jobs/loader'
import { listJobs } from '../jobs/store'
import { checkSignIn, createProbe } from './account-state'
import { accountState, exploreDeps, refusal, signIn } from './deps'
import { JOBRIGHT_PAGE_EXTRACT, jobrightPageOf } from './employer-link'
import { jobrightId } from './parse'
import { listExplore, readCache } from './service'
import { exploreSource } from './source'

/**
 * Settings → Jobright (#146): the hidden job-board browser's Jobright sign-in. The user signs in once in a
 * window on that browser's persistent session; afterwards every Jobright posting page it loads is rendered
 * for them, with the employer's link. The state shown is the last posting page's `logined` (only posting
 * pages carry it), kept with the app settings. Huntgry never sees the password: the user types it on
 * Jobright's own pages.
 */

const source = () => exploreSource(app.isPackaged)

export const jobrightAccount = (): Promise<JobrightAccount> => accountState.read()

const NO_POSTING =
  'Huntgry checks the Jobright sign-in on one of the Explore list\'s postings, and the list could not be loaded. Open Explore (it needs the internet), then try again.'

/**
 * A Jobright posting page to check the sign-in with: the first row of the current workspace's Explore list,
 * else a saved Jobright job's page, else the list fetched now (a fresh workspace that never opened Explore).
 */
async function samplePostingUrl(): Promise<string> {
  const workspace = (await currentInspection().catch(() => null))?.path
  if (!workspace) throw new Error('Open a workspace first.')
  const { sourceUrl, hosts } = source()
  const cached = (await readCache(workspace, sourceUrl, hosts))?.jobs[0]?.url
  if (cached) return cached
  for (const job of await listJobs(workspace).catch(() => [])) {
    for (const url of [job.boardUrl, job.url]) if (url && jobrightId(url, hosts)) return url
  }
  const fetched = (await listExplore(workspace, exploreDeps()).catch(() => null))?.jobs[0]?.url
  if (fetched) return fetched
  throw new Error(NO_POSTING)
}

/** Loads `url` in the hidden browser: the page's `logined`, or `null` when it did not load or say. */
async function probe(url: string): Promise<boolean | null> {
  const res = await loadAndExtract(url, JOBRIGHT_PAGE_EXTRACT)
  return res.status === 'ok' ? jobrightPageOf(res.data).logined : null
}

/**
 * Loads one Jobright posting page in the hidden browser and stores whether it was rendered signed in; a
 * Disconnect that starts meanwhile is never undone (`checkSignIn`).
 */
export async function checkJobrightAccount(): Promise<JobrightAccount> {
  await checkSignIn({
    lifecycle: signIn,
    state: accountState,
    pick: samplePostingUrl,
    load: async (url) => {
      const res = await loadAndExtract(url, JOBRIGHT_PAGE_EXTRACT)
      return res.status === 'ok' ? { ok: true, logined: jobrightPageOf(res.data).logined } : { ok: false, message: res.message }
    }
  })
  return jobrightAccount()
}

/** The open sign-in window, if any: Disconnect closes it. */
let signInWindow: BrowserWindow | null = null

/** Removes Jobright's cookies and site data from the hidden browser's session. */
async function clearJobright(): Promise<void> {
  const ses = configureSession()
  const hostnames = source().hosts.map((h) => h.replace(/:\d+$/, ''))
  const matches = (domain: string | undefined) => {
    const d = (domain ?? '').replace(/^\./, '').toLowerCase()
    return d === 'jobright.ai' || d.endsWith('.jobright.ai') || hostnames.includes(d)
  }
  for (const c of await ses.cookies.get({})) {
    if (!matches(c.domain)) continue
    const host = (c.domain ?? '').replace(/^\./, '')
    await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`, c.name).catch(() => undefined)
  }
  for (const host of source().hosts) {
    const origin = host === 'jobright.ai' || host === 'www.jobright.ai' ? `https://${host}` : `http://${host}`
    await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch(() => undefined)
  }
}

/**
 * Signs the hidden browser out of Jobright. A new account generation first, so no probe already running can
 * store "connected" afterwards; the sign-in window that is open now (and its popups) closes; then the cookies
 * are cleared, and cleared once more after the loads queued so far finished (a response may still set a
 * cookie). Exclusive: Connect and Check started meanwhile wait until it is done, and it waits only for the
 * Connect it cancelled, never for one started after it.
 */
export function disconnectJobright(): Promise<JobrightAccount> {
  return signIn.disconnect(async (cancelled) => {
    const win = signInWindow
    await accountState.reset()
    if (win && !win.isDestroyed()) win.destroy()
    await clearJobright()
    await loaderIdle()
    await cancelled?.catch(() => undefined)
    await clearJobright()
    return jobrightAccount()
  })
}

/** A Chrome user agent: Electron's own names itself and the app, which some sign-in pages (Google's) refuse. */
function chromeUserAgent(): string {
  return app.userAgentFallback.replace(/\s(?:Electron|huntgry)\/\S+/gi, '')
}

/**
 * Opens a Jobright posting in a visible window on the hidden browser's session for the user to sign in.
 * After each page load on a Jobright host, the posting is checked in the background (a load during a check
 * runs one more check after it, `createProbe`); once it reports a signed-in user the window closes. Closing
 * it by hand checks once more. One window at a time; Disconnect closes it and drops its results.
 */
export function connectJobright(parent: BrowserWindow | null): Promise<JobrightAccount> {
  // `signIn.connect` starts this only after a Disconnect in progress, in the new generation.
  return signIn.connect(async () => {
    const generation = accountState.generation()
    // A posting is needed to tell a signed-in user: without one, say so before opening anything.
    const start = await samplePostingUrl()
    const startRefusal = await refusal(start)
    if (startRefusal) throw new Error(startRefusal)
    // Disconnected meanwhile: open nothing (Disconnect waits for this).
    if (accountState.generation() !== generation) return jobrightAccount()
    const hosts = source().hosts
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      title: 'Sign in to Jobright',
      ...(parent ? { parent } : {}),
      webPreferences: { session: configureSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    signInWindow = win
    win.webContents.setUserAgent(chromeUserAgent())
    // A sign-in may open a popup (Google's); it stays on this session, in a child window that closes with this one.
    win.webContents.setWindowOpenHandler(({ url }) =>
      /^https?:\/\//i.test(url) ? { action: 'allow', overrideBrowserWindowOptions: { parent: win, width: 520, height: 680 } } : { action: 'deny' }
    )
    win.webContents.on('did-create-window', (child) => child.webContents.setUserAgent(chromeUserAgent()))

    let signedIn = false
    const checks = createProbe(async () => {
      if (win.isDestroyed() || accountState.generation() !== generation) return true
      if ((await probe(start)) !== true) return false
      if (!(await accountState.record(true, generation))) return true
      signedIn = true
      if (!win.isDestroyed()) win.close()
      return true
    })
    const onJobrightPage = (url: string) => {
      // Only pages on a Jobright host: a sign-in on Google's pages has not finished yet.
      try {
        const host = new URL(url).host.toLowerCase()
        if (hosts.includes(host) || host.endsWith('.jobright.ai')) setTimeout(() => void checks.request(), 800)
      } catch {
        // not a URL: nothing to check
      }
    }
    win.webContents.on('did-navigate', (_e, url) => onJobrightPage(url))
    // Jobright may finish a sign-in without a full page load.
    win.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && onJobrightPage(url))
    const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()))
    void win.loadURL(start).catch(() => undefined)
    await closed
    checks.stop()
    if (signInWindow === win) signInWindow = null
    if (!signedIn && accountState.generation() === generation) {
      // Closed by hand: the sign-in may have finished on a page that was not reloaded.
      const logined = await probe(start).catch(() => null)
      if (logined !== null) await accountState.record(logined, generation)
    }
    return jobrightAccount()
  })
}
