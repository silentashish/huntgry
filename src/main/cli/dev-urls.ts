/**
 * Dev-only escape hatch from the public-host guard, so the in-app browser can
 * open the local mock ATS (`node scripts/mock-ats.mjs`) while testing
 * auto-apply. Only loopback addresses, only in an unpackaged build, only with
 * `HUNTGRY_ALLOW_LOCAL_URLS=1`. Packaged builds ignore the variable.
 */

export const LOCAL_URLS_ENV = 'HUNTGRY_ALLOW_LOCAL_URLS'

export function localUrlsAllowed(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !isPackaged && env[LOCAL_URLS_ENV] === '1'
}

/** `http(s)://localhost`, `127.x.x.x` or `[::1]`, any port. Private-network addresses stay refused. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url.replace(/^ws/i, 'http'))
    if (protocol !== 'http:' && protocol !== 'https:') return false
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}
