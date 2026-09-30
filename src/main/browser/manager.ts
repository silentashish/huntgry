import {
  clipboard,
  Menu,
  shell,
  WebContentsView,
  type BrowserWindow,
  type Debugger,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import type { BrowserRect, BrowserState } from '@shared/browser-types'
import { emit } from '../events'
import { browserSession, setDownloadRefusedHandler } from './session'
import { TabRegistry } from './tabs'
import { isAllowedNavigation, loadErrorMessage, normalizeAddress, refusalFor } from './url'

/**
 * The embedded browser: one `WebContentsView` per tab, children of the main
 * window's content view, drawn over the rectangle the Browser page reserves
 * for them. Main owns every page (so #24 can drive it through
 * `getWebContents` / `attachDebugger`); the renderer only sees `BrowserState`.
 */
export class BrowserManager {
  private readonly registry = new TabRegistry()
  private readonly views = new Map<string, WebContentsView>()
  private rect: BrowserRect | null = null
  private visible = false

  constructor(private readonly win: BrowserWindow) {
    setDownloadRefusedHandler((contents) => {
      const id = this.idOf(contents)
      if (id) {
        this.registry.patch(id, { error: 'Downloads are turned off in the in-app browser. Use Open in browser to download.' })
        this.changed()
      }
    })
    win.on('resize', () => this.layout())
    win.on('closed', () => this.destroyAll())
  }

  state(): BrowserState {
    return this.registry.snapshot()
  }

  /** Opens a tab; blank `input` opens an empty one. */
  async open(input: string, activate = true): Promise<BrowserState> {
    const address = input.trim() ? normalizeAddress(input) : ({ ok: true, url: 'about:blank' } as const)
    if (!address.ok) throw new Error(address.message)
    // Refuse before creating the tab, so no tab ever holds an address it may not load.
    const refusal = await refusalFor(address.url)
    if (refusal) throw new Error(refusal)
    const tab = this.registry.open(address.url, activate)
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true
      }
    })
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    this.views.set(tab.id, view)
    this.win.contentView.addChildView(view)
    this.wire(tab.id, view.webContents)
    this.load(tab.id, address.url)
    this.layout()
    this.changed()
    return this.state()
  }

  close(id: string): BrowserState {
    const view = this.views.get(id)
    this.registry.close(id)
    this.views.delete(id)
    if (view) this.dispose(view)
    this.layout()
    this.changed()
    return this.state()
  }

  activate(id: string): BrowserState {
    this.registry.activate(id)
    this.layout()
    this.changed()
    return this.state()
  }

  /** Loads address-bar text in an existing tab. */
  async navigate(id: string, input: string): Promise<BrowserState> {
    const address = normalizeAddress(input)
    if (!address.ok) throw new Error(address.message)
    this.contents(id)
    // A refused address leaves the tab as it was (page, URL and Open in browser all still agree).
    const refusal = await refusalFor(address.url)
    if (refusal) throw new Error(refusal)
    this.load(id, address.url)
    this.changed()
    return this.state()
  }

  back(id: string): void {
    const history = this.contents(id).navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  forward(id: string): void {
    const history = this.contents(id).navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload(id: string): void {
    this.contents(id).reload()
  }

  stop(id: string): void {
    this.contents(id).stop()
  }

  async openExternal(id: string): Promise<void> {
    const url = this.contents(id).getURL()
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  }

  setBounds(rect: BrowserRect): void {
    this.rect = rect
    this.layout()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.layout()
  }

  /** #24 hook: the page of a tab, for scripting it from main. */
  getWebContents(id: string): WebContents {
    return this.contents(id)
  }

  /** #24 hook: the Chrome DevTools Protocol for a tab (e.g. `DOM.setFileInputFiles` for a resume upload). */
  attachDebugger(id: string): Debugger {
    const dbg = this.contents(id).debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    return dbg
  }

  /** Closes every page (window closed or app quitting) so no renderer process outlives the app. */
  destroyAll(): void {
    for (const id of this.registry.ids()) this.registry.close(id)
    for (const view of this.views.values()) this.dispose(view, false)
    this.views.clear()
  }

  private contents(id: string): WebContents {
    const view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) throw new Error('That tab is closed.')
    return view.webContents
  }

  private idOf(contents: WebContents): string | undefined {
    for (const [id, view] of this.views) if (view.webContents === contents) return id
    return undefined
  }

  /** Loads an address that passed `refusalFor`. */
  private load(id: string, url: string): void {
    this.registry.patch(id, { url, error: null })
    // Failures arrive as `did-fail-load`; the promise only rejects for the same reason.
    this.contents(id)
      .loadURL(url)
      .catch(() => undefined)
  }

  /** Only the active tab is shown, over the placeholder, while the Browser page is on screen. */
  private layout(): void {
    if (this.win.isDestroyed()) return
    const active = this.registry.active
    for (const [id, view] of this.views) {
      const show = this.visible && this.rect !== null && id === active
      if (show && this.rect) view.setBounds(this.rect)
      view.setVisible(show)
    }
  }

  private changed(): void {
    emit('browser:state', this.state())
  }

  private wire(id: string, wc: WebContents): void {
    const sync = (changes: Parameters<TabRegistry['patch']>[1] = {}) => {
      if (wc.isDestroyed()) return
      this.registry.patch(id, {
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        ...changes
      })
      this.changed()
    }
    // Popups become tabs; nothing else may open a window.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (url !== 'about:blank' && isAllowedNavigation(url)) {
        void this.open(url, disposition !== 'background-tab').catch((err: unknown) => {
          this.registry.patch(id, { error: err instanceof Error ? err.message : String(err) })
          this.changed()
        })
      }
      return { action: 'deny' }
    })
    const guard = (event: { url: string; preventDefault(): void }) => {
      if (!isAllowedNavigation(event.url)) event.preventDefault()
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.on('will-frame-navigate', guard)
    wc.on('did-start-loading', () => sync({ loading: true }))
    wc.on('did-stop-loading', () => sync({ loading: false }))
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.registry.patch(id, { error: null })
    })
    wc.on('did-navigate', (_e, url) => sync({ url, title: wc.getTitle() }))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) sync({ url })
    })
    wc.on('page-title-updated', (_e, title) => sync({ title }))
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame) return
      const error = loadErrorMessage(code, description, url)
      if (!error) return
      // The request guard cancels without a reason; re-check to tell a private address from an unknown name.
      if (description === 'ERR_BLOCKED_BY_CLIENT') {
        void refusalFor(url).then((refusal) => sync({ error: refusal ?? error, loading: false }))
      } else {
        sync({ error, loading: false })
      }
    })
    wc.on('render-process-gone', (_e, details) => {
      sync({ error: `The page stopped (${details.reason}). Reload to try again.`, loading: false })
    })
    wc.on('context-menu', (_e, params) => {
      const items: MenuItemConstructorOptions[] = []
      if (params.isEditable) {
        items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
      } else if (params.selectionText) {
        items.push({ role: 'copy' }, { type: 'separator' })
      }
      if (params.linkURL && isAllowedNavigation(params.linkURL)) {
        items.push(
          { label: 'Open Link in New Tab', click: () => void this.open(params.linkURL, false).catch(() => undefined) },
          { label: 'Open Link in System Browser', click: () => void shell.openExternal(params.linkURL) },
          { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' }
        )
      }
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { label: 'Open Page in System Browser', click: () => void this.openExternal(id) }
      )
      Menu.buildFromTemplate(items).popup({ window: this.win })
    })
  }

  private dispose(view: WebContentsView, detach = true): void {
    if (detach && !this.win.isDestroyed()) this.win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
}

let manager: BrowserManager | null = null

/** Binds the browser to the main window (a new window, e.g. macOS re-activate, gets a fresh set of tabs). */
export function attachBrowser(win: BrowserWindow): BrowserManager {
  manager?.destroyAll()
  manager = new BrowserManager(win)
  return manager
}

export function browserManager(): BrowserManager {
  if (!manager) throw new Error('The browser is not ready yet.')
  return manager
}

/** Closes every tab; called before quit. */
export function destroyBrowser(): void {
  manager?.destroyAll()
}
