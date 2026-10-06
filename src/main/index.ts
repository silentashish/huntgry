import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { stopApplicationsWatcher } from './applications/ipc'
import { handleFileScheme, registerFileScheme } from './applications/protocol'
import { stopApply } from './apply/ipc'
import { attachBrowser, destroyBrowser } from './browser/manager'
import { setPackagedBuild } from './cli/env'
import { stopAllRuns } from './cli/ipc'
import { initPipeline, stopPipeline } from './pipeline/ipc'
import { setReviewAuthorityRoot } from './review/authority'
import { stopQueue } from './queue/ipc'
import { startRemote, stopRemote } from './remote/ipc'
import { registerIpcHandlers } from './ipc'

// Menus, the About panel and userData use this name. Packaged builds take the
// bundle name and icon from electron-builder; `npm run dev` gets them from
// scripts/brand-dev-electron.cjs plus the dock icon set below.
app.setName('Huntgry')
// Review decisions and standing approvals live under userData, outside every agent's writable roots (#31).
setReviewAuthorityRoot(() => join(app.getPath('userData'), 'review'))
// CLI discovery's e2e escape hatch (HUNTGRY_E2E) is only honoured by unpackaged builds.
setPackagedBuild(app.isPackaged)

// Custom schemes must be registered before the app is ready.
registerFileScheme()

/** Opens the sandboxed main window; the renderer reaches the filesystem only through IPC. */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Huntgry',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())
  // Job postings open in in-app tabs drawn over this window (src/main/browser).
  attachBrowser(win)

  // The renderer never navigates or opens windows; external links go to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  // The profile editor blocks unload while it has unsaved edits; ask instead of silently refusing to close.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Close Without Saving', 'Keep Editing'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes to your master profile.',
      detail: 'Close anyway? Your edits will be lost.'
    })
    if (choice === 0) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    // Surface renderer warnings/errors in the dev terminal.
    win.webContents.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') {
        console.log(`[renderer:${event.level}] ${event.message}`)
      }
    })
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'Huntgry',
    applicationVersion: app.getVersion(),
    copyright: 'Local-first dashboard for the Claude resume-tailor skill',
    iconPath: icon
  })
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)
  handleFileScheme()
  registerIpcHandlers()
  createWindow()
  // Resumes an unattended pipeline interrupted by a restart, keeps the Mac awake while it has work.
  initPipeline()
  // The relay session (ADR-0001): outbound only, off until enabled in Settings.
  void startRemote()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Never leave a `claude` child running after the app is gone. Electron does not
// wait for async listeners, so hold the first quit until the runs are stopped
// and saved, then quit again (the guard lets that second quit through).
let runsStopped = false
app.on('before-quit', (event) => {
  stopApplicationsWatcher()
  // Before the tabs close, so no apply session or debugger outlives them.
  stopApply()
  destroyBrowser()
  if (runsStopped) return
  event.preventDefault()
  // The queue stops following its runs first, so they reload as interrupted, not cancelled.
  // The remote session closes after the queue and the runs, so a phone's last command is not cut mid-way.
  void stopPipeline()
    .then(stopQueue)
    .then(stopAllRuns)
    .then(stopRemote)
    .catch((err: unknown) => console.error('Stopping runs before quit failed:', err))
    .finally(() => {
      runsStopped = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
