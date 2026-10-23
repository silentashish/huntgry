import { app, BrowserWindow } from 'electron'
import type { JobrightAccount } from '@shared/explore-types'
import { refusalFor } from '../browser/url'
import { localUrlsAllowed, loopbackOnly } from '../cli/dev-urls'
import { currentInspection, settingsFile } from '../current-workspace'
import { configureSession, loadAndExtract } from '../jobs/loader'
import { listJobs } from '../jobs/store'
import { loadSettings, saveSettings } from '../workspace'
import { accountOf, JOBRIGHT_PAGE_EXTRACT, jobrightPageOf, type LinkDeps } from './employer-link'
import { jobrightId } from './parse'
import { readCache } from './service'
import { exploreSource } from './source'

/**
 * Settings → Jobright (#146): the hidden job-board browser's Jobright sign-in. The user signs in once in a
 * window on that browser's persistent session; afterwards every Jobright posting page it loads is rendered
 * for them, with the employer's link. The state shown is the last page's `logined`, kept with the app
 * settings. Huntgry never sees the password: the user types it on Jobright's own pages.
 */

const source = () => exploreSource(app.isPackaged)

const refusal = (url: string) => refusalFor(url, undefined, localUrlsAllowed(app.isPackaged), loopbackOnly(app.isPackaged))

export async function jobrightAccount(): Promise<JobrightAccount> {
  return accountOf(await loadSettings(settingsFile()))
}

/** Stores what a loaded Jobright posting page said about the sign-in. */
export async function recordLogin(logined: boolean): Promise<void> {
  await saveSettings(settingsFile(), { jobright: { connected: logined, checkedAt: new Date().toISOString() } })
}

/** What `addExplore` and Fetch full description use to look up employer links. */
export function linkDeps(): LinkDeps & { connected(): Promise<boolean> } {
  return {
    load: loadAndExtract,
    hosts: source().hosts,
    refusal,
    onLogin: recordLogin,
    connected: async () => (await jobrightAccount()).connected === true
  }
}

/**
 * A Jobright posting page to check the sign-in with (only posting pages say whether they were rendered for a
 * signed-in user): the first row of the current workspace's Explore list, else a saved Jobright job's page.
 */
async function samplePostingUrl(): Promise<string | null> {
  const workspace = (await currentInspection().catch(() => null))?.path
  if (!workspace) return null
  const { sourceUrl, hosts } = source()
  const listed = (await readCache(workspace, sourceUrl, hosts))?.jobs[0]?.url
  if (listed) return listed
  for (const job of await listJobs(workspace).catch(() => [])) {
    for (const url of [job.boardUrl, job.url]) if (url && jobrightId(url, hosts)) return url
  }
  return null
}

/** Loads one Jobright posting page in the hidden browser and stores whether it was rendered signed in. */
export async function checkJobrightAccount(): Promise<JobrightAccount> {
  const url = await samplePostingUrl()
  if (!url) throw new Error('Open Explore once first: Huntgry checks the sign-in on one of its Jobright postings.')
  const res = await loadAndExtract(url, JOBRIGHT_PAGE_EXTRACT)
  if (res.status !== 'ok') throw new Error(`Could not check the Jobright sign-in: ${res.message}`)
  const { logined } = jobrightPageOf(res.data)
  if (logined === null) throw new Error('The Jobright page did not say whether you are signed in. Try again later.')
  await recordLogin(logined)
  return jobrightAccount()
}

/** Removes Jobright's cookies and site data from the hidden browser, then marks the account as not connected. */
export async function disconnectJobright(): Promise<JobrightAccount> {
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
  await recordLogin(false)
  return jobrightAccount()
}

/** A Chrome user agent: Electron's own names itself and the app, which some sign-in pages (Google's) refuse. */
function chromeUserAgent(): string {
  return app.userAgentFallback.replace(/\s(?:Electron|huntgry)\/\S+/gi, '')
}

let open: Promise<JobrightAccount> | null = null

/**
 * Opens a Jobright posting in a visible window on the hidden browser's session for the user to sign in.
 * After each page load on a Jobright host, the posting is checked in the background; once it reports a
 * signed-in user the window closes. Closing it by hand checks once more. One window at a time.
 */
export function connectJobright(parent: BrowserWindow | null): Promise<JobrightAccount> {
  if (open) return open
  open = (async () => {
    const start = (await samplePostingUrl()) ?? 'https://jobright.ai/'
    const startRefusal = await refusal(start)
    if (startRefusal) throw new Error(startRefusal)
    const hosts = source().hosts
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      title: 'Sign in to Jobright',
      ...(parent ? { parent } : {}),
      webPreferences: { session: configureSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.setUserAgent(chromeUserAgent())
    // A sign-in may open a popup (Google's); it stays on this session, in a child window.
    win.webContents.setWindowOpenHandler(({ url }) =>
      /^https?:\/\//i.test(url) ? { action: 'allow', overrideBrowserWindowOptions: { parent: win, width: 520, height: 680 } } : { action: 'deny' }
    )
    win.webContents.on('did-create-window', (child) => child.webContents.setUserAgent(chromeUserAgent()))

    let checking = false
    let signedIn = false
    const check = async () => {
      if (checking || signedIn || win.isDestroyed()) return
      checking = true
      try {
        const res = await loadAndExtract(start, JOBRIGHT_PAGE_EXTRACT)
        const { logined } = res.status === 'ok' ? jobrightPageOf(res.data) : { logined: null }
        if (logined === true) {
          signedIn = true
          await recordLogin(true)
          if (!win.isDestroyed()) win.close()
        }
      } finally {
        checking = false
      }
    }
    win.webContents.on('did-navigate', (_e, url) => {
      // Only pages on a Jobright host: a sign-in on Google's pages has not finished yet.
      try {
        const host = new URL(url).host.toLowerCase()
        if (hosts.includes(host) || host.endsWith('.jobright.ai')) setTimeout(() => void check(), 800)
      } catch {
        // not a URL: nothing to check
      }
    })
    const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()))
    void win.loadURL(start).catch(() => undefined)
    await closed
    if (!signedIn) {
      // Closed by hand: the sign-in may have finished on a page that was not reloaded.
      const res = await loadAndExtract(start, JOBRIGHT_PAGE_EXTRACT)
      const { logined } = res.status === 'ok' ? jobrightPageOf(res.data) : { logined: null }
      if (logined !== null) await recordLogin(logined)
    }
    return jobrightAccount()
  })().finally(() => {
    open = null
  })
  return open
}
