/**
 * Explore's two plain HTTPS requests from the main process (#142, #169): the README GET and the newgrad-jobs API
 * POST. No cookies, no profile data; a timeout, no redirects, and a body cap counted as the bytes arrive.
 */

export const MAX_BYTES = 5 * 1024 * 1024
export const TIMEOUT_MS = 20_000

const why = (err: unknown, otherwise: string) =>
  err instanceof Error && err.name === 'TimeoutError' ? 'it did not answer in time' : otherwise

/** Wording of the errors, per request. */
interface Messages {
  /** "Could not reach <where>" */
  where: string
  /** What it is, for "… answered HTTP 503 for <what>", "<What> is unexpectedly large". */
  what: string
}

/** The body as UTF-8, at most `MAX_BYTES` (Content-Length may be absent or wrong, so the bytes are counted too). */
async function readCapped(res: Response, m: Messages): Promise<string> {
  const tooLarge = `${m.what[0].toUpperCase()}${m.what.slice(1)} is unexpectedly large; not read.`
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) throw new Error(tooLarge)
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) break
      chunks.push(value)
    }
  } catch (err) {
    throw new Error(`Could not read ${m.what} from ${m.where} (${why(err, 'the connection dropped')}).`)
  }
  if (total > MAX_BYTES) {
    await reader.cancel().catch(() => {})
    throw new Error(tooLarge)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function request(url: string, init: RequestInit, timeoutMs: number, m: Messages): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error', credentials: 'omit' })
  } catch (err) {
    throw new Error(`Could not reach ${m.where} for ${m.what} (${why(err, 'you may be offline')}).`)
  }
  const where = m.where[0].toUpperCase() + m.where.slice(1)
  if (!res.ok) throw new Error(`${where} answered HTTP ${res.status} for ${m.what}.`)
  return readCapped(res, m)
}

/** Plain HTTPS GET of the README. */
export function fetchReadme(url: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  return request(url, { headers: { accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1' } }, timeoutMs, {
    where: 'GitHub',
    what: 'the Jobright list'
  })
}

/** Plain HTTPS POST of a JSON body to the newgrad-jobs API; the answer parsed as JSON (untrusted). */
export async function postJson(url: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const m = { where: 'the newgrad-jobs API', what: 'the Jobright jobs' }
  const text = await request(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
    timeoutMs,
    m
  )
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('The newgrad-jobs API did not answer with JSON.')
  }
}
