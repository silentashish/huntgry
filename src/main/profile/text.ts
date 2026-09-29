/** Small text helpers shared by the Markdown format and the resume parser. */

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?'
const SEASON = '(?:Spring|Summer|Fall|Autumn|Winter)'
const YEAR = '(?:19|20)\\d{2}'
const DATE = `(?:\\b(?:${MONTH}|${SEASON})\\s+${YEAR}|\\b\\d{1,2}\\/${YEAR}|\\b${YEAR})\\b`
const OPEN_END = '\\b(?:Present|Current|Now|Ongoing|Today)\\b'

/** `Aug 2024 – Present`, `2019 - 2021`, `03/2019 to 05/2021`, ... */
const DATE_RANGE_RE = new RegExp(`(${DATE})\\s*(?:–|—|-|to|until)\\s*(${DATE}|${OPEN_END})`, 'i')
/** A lone date such as `May 2026` or `2023`. */
const SINGLE_DATE_RE = new RegExp(`(${DATE}|${OPEN_END})`, 'i')

export interface DateMatch {
  start: string
  end: string
  /** The input with the date removed and separators tidied. */
  rest: string
}

/** Finds a date range (or, with `allowSingle`, a single date used as the end date). */
export function extractDates(text: string, allowSingle = false): DateMatch | null {
  const range = DATE_RANGE_RE.exec(text)
  if (range) {
    return { start: range[1].trim(), end: range[2].trim(), rest: tidy(cut(text, range.index, range[0].length)) }
  }
  if (!allowSingle) return null
  const single = SINGLE_DATE_RE.exec(text)
  if (!single) return null
  return { start: '', end: single[1].trim(), rest: tidy(cut(text, single.index, single[0].length)) }
}

export function hasDateRange(text: string): boolean {
  return DATE_RANGE_RE.test(text)
}

function cut(text: string, index: number, length: number): string {
  return text.slice(0, index) + '\t' + text.slice(index + length)
}

/** Collapses whitespace runs and trims separators left dangling at either end. */
export function tidy(text: string): string {
  return text
    .replace(/[  ]+/g, ' ')
    .replace(/^[\s|,;·•–—-]+|[\s|,;·•–—-]+$/g, '')
    .trim()
}

/** Formats a start/end pair the way resumes write it. */
export function formatDateRange(start: string, end: string): string {
  if (start && end) return `${start} – ${end}`
  return start || end
}

/**
 * Splits `a, b (c, d), e` on commas and semicolons that are not inside brackets,
 * so `AWS (EC2, ECS, S3)` stays one item.
 */
export function splitList(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if ((ch === ',' || ch === ';') && depth === 0) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/i
const BARE_DOMAIN_RE = /\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|me|app|ai|co|edu|gov|info|xyz|tech|site)(?:\/[^\s<>()"',;]*)?/i

/** First URL in `text`: an explicit `https://...`, else a bare domain such as `github.com/me`. */
export function findUrl(text: string): string | null {
  const explicit = URL_RE.exec(text)
  if (explicit) return explicit[0]
  const bare = BARE_DOMAIN_RE.exec(text)
  if (bare && !text.slice(Math.max(0, bare.index - 1), bare.index).includes('@')) return bare[0]
  return null
}

/**
 * Link fields accept the skill's `display text (link: https://...)` convention,
 * a bare URL, or anything else (kept as typed).
 */
export function linkValue(text: string): string {
  const convention = /\(link:\s*([^)]+)\)/i.exec(text)
  if (convention) return convention[1].trim()
  return findUrl(text) ?? text.trim()
}

/** `ASHISH GAUTAM` → `Ashish Gautam`; leaves mixed-case text alone. */
export function unshout(text: string): string {
  if (text !== text.toUpperCase() || !/[A-Z]/.test(text)) return text
  return text.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
}

/** Lower-case, `&` → `and`, punctuation dropped: for matching headings and field names. */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function singleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}
