/**
 * Fetches a job posting URL in the main process so the Claude run never needs
 * network access: the text goes into the first message instead. Any tool
 * that lets Claude reach a posting's site would also let a malicious posting
 * make Claude send master-profile data there (e.g. in a URL).
 */

const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 15_000
/** Shorter than this, the page is a shell that needs JavaScript, or a bot wall. */
export const MIN_POSTING_CHARS = 300

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  bull: '•'
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Posting HTML → readable text: list items become `- `, blocks become paragraphs. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|section|tr)>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A schema.org JobPosting in the page's JSON-LD (handles arrays and `@graph`). */
function jobPostingOf(html: string): Record<string, unknown> | null {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(m[1])
    } catch {
      continue
    }
    const stack: unknown[] = [parsed]
    while (stack.length > 0) {
      const item = stack.shift()
      if (Array.isArray(item)) stack.push(...item)
      else if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        const t = o['@type']
        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return o
        if (Array.isArray(o['@graph'])) stack.push(...o['@graph'])
      }
    }
  }
  return null
}

/** The posting as text: the JSON-LD description with its title and company, else the page's main text. */
export function postingText(html: string): string {
  const posting = jobPostingOf(html)
  if (posting && typeof posting.description === 'string') {
    const org = posting.hiringOrganization as { name?: unknown } | undefined
    const head = [
      typeof posting.title === 'string' ? `# ${posting.title}` : '',
      typeof org?.name === 'string' ? org.name : ''
    ]
    return [...head.filter(Boolean), htmlToText(posting.description)].join('\n\n')
  }
  const main = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<body[\s\S]*<\/body>/i.exec(html)?.[0] ?? html
  return htmlToText(main)
}

export type Fetcher = (
  url: string,
  init: { signal: AbortSignal; redirect: 'follow'; headers: Record<string, string> }
) => Promise<Response>

/**
 * Downloads `url` (http/https, ≤ 2 MB, 15 s) and returns the posting text.
 * Throws a message telling the user to paste the description when the page
 * cannot be read (blocked, needs JavaScript, not HTML).
 */
export async function fetchPostingText(url: string, fetcher: Fetcher): Promise<string> {
  const paste = 'Paste the job description instead.'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetcher(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { accept: 'text/html,application/xhtml+xml' }
      })
    } catch {
      throw new Error(`Could not load the posting. ${paste}`)
    }
    if (!res.ok) throw new Error(`The job site answered ${res.status}. ${paste}`)
    const type = res.headers.get('content-type') ?? ''
    if (type && !/html|text\/plain/i.test(type))
      throw new Error(`The posting URL is not a web page (${type}). ${paste}`)
    const reader = res.body?.getReader()
    if (!reader) throw new Error(`The posting page was empty. ${paste}`)
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
    const html = Buffer.concat(chunks).toString('utf8')
    const text = postingText(html)
    if (text.length < MIN_POSTING_CHARS) {
      throw new Error(
        `The posting page has almost no text; it probably needs JavaScript or asked for a human check. ${paste}`
      )
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}
