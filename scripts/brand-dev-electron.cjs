// `npm run dev` launches node_modules/electron/dist/Electron.app, so macOS shows
// "Electron" and the Electron icon in the menu bar, Dock and Cmd-Tab. This
// renames that dev copy to Huntgry and gives it our icon. It only touches
// node_modules, is idempotent, and is a no-op off macOS. Packaged builds get
// their name and icon from electron-builder instead.
const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const NAME = 'Huntgry'
const root = join(__dirname, '..')
let electronBinary
try {
  electronBinary = require(join(root, 'node_modules/electron')) // path to Contents/MacOS/Electron
} catch {
  process.exit(0) // electron not installed yet
}
const contents = dirname(dirname(electronBinary))
const plist = join(contents, 'Info.plist')
const icns = join(root, 'resources/icon.icns')
if (!existsSync(plist) || !existsSync(icns)) process.exit(0)

const read = (key) => {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const target = join(contents, 'Resources', read('CFBundleIconFile') || 'electron.icns')
const iconUpToDate = existsSync(target) && readFileSync(target).equals(readFileSync(icns))
if (read('CFBundleName') === NAME && read('CFBundleDisplayName') === NAME && iconUpToDate) process.exit(0)

execFileSync('plutil', ['-replace', 'CFBundleName', '-string', NAME, plist])
execFileSync('plutil', ['-replace', 'CFBundleDisplayName', '-string', NAME, plist])
copyFileSync(icns, target)
// Editing Info.plist invalidates the bundle's ad-hoc signature; re-sign it ad hoc.
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', dirname(contents)], { stdio: 'ignore' })
} catch {
  // Unsigned is fine for local dev on Intel; Apple Silicon needs the signature, so report it.
  console.warn('brand-dev-electron: could not re-sign Electron.app; run `codesign --force --deep --sign - ' + dirname(contents) + '`.')
}
// Nudge LaunchServices so the Dock picks up the new name and icon.
execFileSync('touch', [dirname(contents)])
console.log(`brand-dev-electron: dev Electron.app now shows as ${NAME}.`)
