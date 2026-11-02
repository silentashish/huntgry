import { refusalFor } from '../browser/url'
import { isLoopbackUrl } from '../cli/dev-urls'
import type { Fetcher } from '../cli/posting'
import { assertPublicUrl, resolveHost, type ResolveHost } from '../cli/public-url'

/**
 * One GET of a JSON API whose address came from user input or a page (an Oracle Candidate Experience tenant, #191),
 * from the main process: public hosts only (`assertPublicUrl`, connected at the checked addresses with
 * `pinnedFetch`), no redirects, no cookies or credentials, a timeout and a body cap.
 */

export const MAX_JSON_BYTES = 2 * 1024 * 1024
export const JSON_TIMEOUT_MS = 15_000

const HEADERS = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Huntgry'
}

/** GETs a URL and parses the answer as JSON (untrusted). The app's is `publicJson()` in loader.ts, a stub in tests. */
export interface JsonFetcher {
  (url: string): Promise<JsonResult>
  /** Dev builds with the mock-server allowance: a page may name a loopback API host (e2e, `scripts/mock-ats`). */
  allowLoopback?: boolean
}

export type JsonResult = { status: 'ok'; data: unknown } | { status: 'error'; httpStatus?: number; message: string }

export interface PublicJsonDeps {
  /** `pinnedFetch` in the app. */
  fetcher: Fetcher
  resolve?: ResolveHost
  /** The dev-only mock-ATS allowance (`localUrlsAllowed`). */
  allowLoopback?: boolean
  /** The e2e harness's egress restriction (`loopbackOnly`). */
  loopbackOnly?: boolean
  timeoutMs?: number
}

/** The addresses to connect to, after the same checks as the hidden loader's (`refusalFor`). */
async function addressesFor(url: string, deps: PublicJsonDeps): Promise<string[]> {
  const resolve = deps.resolve ?? resolveHost
  if (deps.loopbackOnly || (deps.allowLoopback && isLoopbackUrl(url))) {
    const refusal = await refusalFor(url, resolve, deps.allowLoopback, deps.loopbackOnly)
    if (refusal) throw new Error(refusal)
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return [host === 'localhost' ? '127.0.0.1' : host]
  }
  return (await assertPublicUrl(url, resolve)).addresses
}

export async function getPublicJson(url: string, deps: PublicJsonDeps): Promise<JsonResult> {
  let host = url
  try {
    host = new URL(url).host
  } catch {
    return { status: 'error', message: 'Not a valid URL.' }
  }
  // One deadline for the whole call: the lookup of a host a page named, the connection and the body.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? JSON_TIMEOUT_MS)
  const late = { status: 'error', message: `${host} did not answer in time.` } as const
  const deadline = new Promise<never>((_resolve, reject) =>
    ctrl.signal.addEventListener('abort', () => reject(new Error(late.message)), { once: true })
  )
  deadline.catch(() => undefined)
  try {
    let addresses: string[]
    try {
      addresses = await Promise.race([addressesFor(url, deps), deadline])
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    // A lookup that settled as the deadline passed must not start a request.
    if (ctrl.signal.aborted) return late
    let res: Response
    try {
      res = await deps.fetcher(url, { signal: ctrl.signal, headers: HEADERS, addresses })
    } catch {
      return { status: 'error', message: `Could not reach ${host}.` }
    }
    // A redirect is not followed: an API that redirects is not answering (Oracle sends its custom domains' to a 404).
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return { status: 'error', httpStatus: res.status, message: `${host} answered HTTP ${res.status}.` }
    }
    const reader = res.body?.getReader()
    if (!reader) return { status: 'error', message: `${host} sent an empty answer.` }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_JSON_BYTES) {
          await reader.cancel().catch(() => undefined)
          return { status: 'error', message: `${host} sent an unexpectedly large answer; not read.` }
        }
        chunks.push(value)
      }
    } catch {
      return { status: 'error', message: `Could not read the answer from ${host}.` }
    }
    try {
      return { status: 'ok', data: JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown }
    } catch {
      return { status: 'error', message: `${host} did not answer with JSON.` }
    }
  } finally {
    clearTimeout(timer)
  }
}
