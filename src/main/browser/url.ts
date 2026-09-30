import { MAX_URL_LENGTH } from '@shared/browser-types'
import { isLoopbackUrl } from '../cli/dev-urls'
import { assertPublicUrl, resolveHost, type ResolveHost } from '../cli/public-url'

/**
 * Address-bar input and navigation rules for the embedded browser. Pure, so
 * they are unit-tested; the manager applies them to every load, redirect and
 * popup.
 */

export type Address = { ok: true; url: string } | { ok: false; message: string }

const BLANK = 'about:blank'

/**
 * Turns address-bar text into a URL to load: `http(s)://…` is kept, a bare
 * host such as `jobs.ashbyhq.com/acme` gets `https://`, and every other scheme
 * (`javascript:`, `file:`, `data:`, `chrome:`…) is refused. There is no search
 * engine: text that is not a host is refused too.
 */
export function normalizeAddress(input: string): Address {
  const text = input.trim()
  if (!text) return { ok: false, message: 'Enter a URL.' }
  if (text.length > MAX_URL_LENGTH) return { ok: false, message: 'That URL is too long.' }
  if (text.toLowerCase() === BLANK) return { ok: true, url: BLANK }
  let candidate = text
  if (!/^https?:\/\//i.test(text)) {
    // `host:port` is not a scheme; anything else before a colon is.
    if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(text)) {
      return { ok: false, message: 'Only http:// and https:// addresses can be opened.' }
    }
    candidate = `https://${text}`
  }
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, message: 'Enter a URL, e.g. jobs.example.com/posting.' }
  }
  const host = url.hostname
  if (/\s/.test(text) || !(host.includes('.') || host.startsWith('[') || host === 'localhost')) {
    return { ok: false, message: 'Enter a URL, e.g. jobs.example.com/posting.' }
  }
  return { ok: true, url: url.href }
}

/** Whether a page may load `url` (navigation, redirect or new tab): http(s) and the empty page only. */
export function isAllowedNavigation(url: string): boolean {
  if (url === BLANK) return true
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Why `url` may not be loaded, or `null` when it may: a local or
 * private-network address, or a name that does not resolve (so a typo says
 * "Could not find …", not "private address"). `allowLoopback` is the dev-only
 * mock-ATS allowance (`localUrlsAllowed`).
 */
export async function refusalFor(
  url: string,
  resolve: ResolveHost = resolveHost,
  allowLoopback = false
): Promise<string | null> {
  if (url === BLANK) return null
  if (allowLoopback && isLoopbackUrl(url)) return null
  try {
    await assertPublicUrl(url, resolve)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Message for a failed main-frame load, or `null` when it is not worth showing (aborted by a new navigation). */
export function loadErrorMessage(code: number, description: string, url: string): string | null {
  // -3 ERR_ABORTED: the user navigated again, stopped, or the load became a download.
  if (code === -3) return null
  const what = description || `error ${code}`
  if (what === 'ERR_BLOCKED_BY_CLIENT') return `Blocked: ${hostOf(url)} is a local or private-network address.`
  return `Could not load ${hostOf(url)} (${what}).`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
