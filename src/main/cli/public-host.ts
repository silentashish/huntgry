import { isLoopbackUrl } from './dev-urls'
import { assertPublicUrl, resolveHost, type ResolveHost } from './public-url'

/**
 * Per-request SSRF guard for Chromium sessions that load user-supplied URLs
 * (the hidden job-board loader and the embedded browser): every request the
 * page makes is checked with `assertPublicUrl`, cached per host for a minute.
 * Chromium resolves names itself, so unlike `pinnedFetch` this cannot pin the
 * checked address; a DNS answer that changes within the TTL is the known gap.
 */

export const HOST_CHECK_TTL_MS = 60_000

export type PublicHostCheck = (url: string) => Promise<boolean>

/** A cached `isPublicHost`; `resolve` and `now` are injectable for tests. */
export function createPublicHostCheck(resolve: ResolveHost = resolveHost, now: () => number = Date.now): PublicHostCheck {
  const checks = new Map<string, { ok: boolean; at: number }>()
  return async (url) => {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return false
    }
    const cached = checks.get(host)
    if (cached && now() - cached.at < HOST_CHECK_TTL_MS) return cached.ok
    // WebSocket URLs are checked as their http(s) equivalent.
    const ok = await assertPublicUrl(url.replace(/^ws/i, 'http'), resolve).then(
      () => true,
      () => false
    )
    checks.set(host, { ok, at: now() })
    return ok
  }
}

/** Whether `url`'s host is public (see `assertPublicUrl`), cached per host. Shared by every guarded session. */
export const isPublicHost: PublicHostCheck = createPublicHostCheck()

/** URL patterns `guardSession` checks: everything that can leave the machine from a page. */
export const GUARDED_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']

/**
 * The `webRequest.onBeforeRequest` listener of a guarded session: cancels
 * every request whose host is not public. With `allowLoopback` (the dev-only
 * `HUNTGRY_ALLOW_LOCAL_URLS=1` allowance, see cli/dev-urls.ts) loopback
 * addresses pass without a check; private-network addresses stay refused.
 */
export function createRequestGuard(
  allowLoopback: boolean,
  check: PublicHostCheck = isPublicHost
): (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void {
  return (details, callback) => {
    if (allowLoopback && isLoopbackUrl(details.url)) return callback({ cancel: false })
    void check(details.url).then((ok) => callback({ cancel: !ok }))
  }
}
