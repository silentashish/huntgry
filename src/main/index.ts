import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'

// Menus, the About panel and userData use this name. Packaged builds take the
// bundle name and icon from electron-builder; `npm run dev` gets them from
// scripts/brand-dev-electron.cjs plus the dock icon set below.
app.setName('Huntgry')

/** Opens the sandboxed main window; the renderer reaches the filesystem only through IPC. */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 640,
    minHeight: 480,
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
  registerIpcHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
