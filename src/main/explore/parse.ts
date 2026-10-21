import type { ExploreJob, WorkModel } from '@shared/explore-types'

/**
 * Reads Jobright's new-grad list (#142): the one Markdown table of the README, under `## Daily Job List`.
 *
 * ```
 * | Company | Job Title | Location | Work Model | Date Posted |
 * | **[Rocket](https://www.rocketcompanies.com)** | **[Software Engineer I](https://jobright.ai/jobs/info/<id>?utm_…)** | Detroit, MI, United States | On Site | Oct 21 |
 * | ↳ | **[Formal Verification Engineer](https://jobright.ai/jobs/info/<id>…)** | Mountain View | Remote | Oct 21 |
 * ```
 *
 * The README is untrusted data: a row is kept only when its job link is a Jobright posting page
 * (`https://jobright.ai/jobs/info/<id>`), and a company link only when it is a public-looking http(s) URL.
 * Anything else (another host, `javascript:`, a malformed cell or date) drops the row or the link.
 */

/** The list Explore reads. A constant so other Jobright lists (data, PM, interns) are a small change later. */
export const JOBRIGHT_NEW_GRAD_README =
  'https://raw.githubusercontent.com/jobright-ai/2026-Software-Engineer-New-Grad/master/README.md'

/** Hosts a row's job link may point to. */
export const JOBRIGHT_HOSTS: readonly string[] = ['jobright.ai', 'www.jobright.ai']

/** At most this many rows are read (the README keeps ~8 days, ~700 rows). */
export const MAX_ROWS = 5000

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` of a date in local time. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * `Oct 21` → `2026-10-21`. The list gives no year: it is `today`'s, unless that day would be after
 * today (more than a day ahead, allowing for time zones), then last year's. `null` for anything else.
 */
export function inferDate(text: string, today: Date): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})$/.exec(text.trim())
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  const day = Number(m[2])
  if (month < 0 || day < 1 || day > 31) return null
  let year = today.getFullYear()
  const candidate = (y: number) => new Date(y, month, day)
  if (candidate(year).getTime() > today.getTime() + 86_400_000) year -= 1
  const date = candidate(year)
  // `Feb 30` rolls over into March: not a real day.
  if (date.getMonth() !== month || date.getDate() !== day) return null
  return localDay(date)
}

/** "On Site" / "Onsite" / "Remote" / "Hybrid" → the work model; `null` when it is none of them. */
export function workModelOf(text: string): WorkModel | null {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (t === 'remote') return 'Remote'
  if (t === 'hybrid') return 'Hybrid'
  if (t === 'onsite') return 'On Site'
  return null
}

/** `**[text](url)**` → text and URL; plain text → text and no URL. */
export function linkCell(cell: string): { text: string; url: string | null } {
  const c = cell
    .trim()
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim()
  const m = /^\[(.*)\]\(\s*<?([^\s<>]+)>?\s*\)$/.exec(c)
  if (!m) return { text: plain(c), url: null }
  return { text: plain(m[1]), url: m[2] }
}

/** Markdown emphasis and escapes removed, whitespace squashed, length capped. */
function plain(s: string): string {
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** The Jobright posting id of a job link on an allowed host, or `null`. */
export function jobrightId(url: string, hosts: readonly string[] = JOBRIGHT_HOSTS): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  if (!hosts.includes(u.host.toLowerCase())) return null
  const m = /^\/jobs\/info\/([A-Za-z0-9]{6,64})\/?$/.exec(u.pathname)
  return m ? m[1] : null
}

/** A company link worth keeping: http(s), a dotted host name, no credentials, not local. */
export function safeCompanyUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password) return null
    const host = u.hostname.toLowerCase()
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return null
    if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null
    return u.toString().slice(0, 500)
  } catch {
    return null
  }
}

/** Cells of a table row (`| a | b |`), pipes escaped as `\|` kept inside their cell. */
function cellsOf(line: string): string[] | null {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return null
  return t
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
}

export interface ParseOptions {
  /** "Today", for the year of `Mon D` dates. */
  today?: Date
  /** Hosts a job link may point to (the e2e mock server adds its own). */
  hosts?: readonly string[]
}

/**
 * The rows of the list, in README order. `↳` in the Company column means the previous row's company
 * (and its link). Malformed rows are skipped; so are rows repeating a job id already read.
 */
export function parseReadme(markdown: string, opts: ParseOptions = {}): ExploreJob[] {
  const today = opts.today ?? new Date()
  const hosts = opts.hosts ?? JOBRIGHT_HOSTS
  const jobs: ExploreJob[] = []
  const seen = new Set<string>()
  let last: { company: string; companyUrl: string | null } | null = null
  for (const line of markdown.split(/\r?\n/)) {
    if (jobs.length >= MAX_ROWS) break
    const cells = cellsOf(line)
    if (!cells || cells.length < 5) continue
    const [companyCell, titleCell, locationCell, workCell, dateCell] = cells
    // The header and the `| --- |` separator.
    if (/^company$/i.test(companyCell) || /^:?-+:?$/.test(companyCell)) continue
    let company: { company: string; companyUrl: string | null }
    if (companyCell === '↳') {
      if (!last) continue
      company = last
    } else {
      const c = linkCell(companyCell)
      if (!c.text) {
        last = null
        continue
      }
      company = { company: c.text, companyUrl: safeCompanyUrl(c.url) }
      last = company
    }
    const t = linkCell(titleCell)
    const id = t.url ? jobrightId(t.url, hosts) : null
    const postedAt = inferDate(plain(dateCell), today)
    if (!t.text || !id || !postedAt || seen.has(id)) continue
    seen.add(id)
    // Jobright's own links are rewritten to its canonical https origin; a test host keeps its own.
    const linked = new URL(t.url!)
    const origin = JOBRIGHT_HOSTS.includes(linked.host.toLowerCase()) ? 'https://jobright.ai' : linked.origin
    jobs.push({
      id,
      company: company.company,
      companyUrl: company.companyUrl,
      title: t.text,
      url: `${origin}/jobs/info/${id}`,
      location: plain(locationCell),
      workModel: workModelOf(plain(workCell)),
      postedAt
    })
  }
  return jobs
}
