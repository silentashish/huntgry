// Renders resources/icon.svg to resources/icon.png (1024x1024, transparent) with Electron's
// own Chromium, so no image tooling is needed. Run: npm run icons
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const svg = readFileSync(join(root, 'resources/icon.svg'), 'utf8')
const html = `<!doctype html><html><head><style>
  html, body { margin: 0; overflow: hidden; background: transparent; }
  svg { display: block; }
</style></head><body>${svg}</body></html>`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true, deviceScaleFactor: 1 }
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(root, 'resources/icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
