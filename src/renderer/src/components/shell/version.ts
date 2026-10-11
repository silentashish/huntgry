/** Set by Vite (`define` in electron.vite.config.ts) from package.json; absent under Vitest. */
declare const __APP_VERSION__: string | undefined

/** The app's version (`0.1.0`), `''` when unknown. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

/** `v0.1 · the hound` (major.minor, like the Figma sidebar), or just the tagline without a version. */
export function versionLine(version: string = APP_VERSION): string {
  const m = /^(\d+)\.(\d+)/.exec(version)
  return m ? `v${m[1]}.${m[2]} · the hound` : 'the hound'
}
