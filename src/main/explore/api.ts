import { EXPLORE_MAX_ROWS, H1B_VALUES, JOBRIGHT_ID_PATTERN, type ExploreJob, type H1bSponsored } from '@shared/explore-types'
import { JOBRIGHT_HOSTS, jobrightId, localDay, workModelOf } from './parse'

/**
 * The API behind newgrad-jobs.com (#169): `POST https://jobright.ai/swan/mini-sites/list?position=<offset>&count=<n>`
 * with `{"category":"newgrad:us:swe"}`, newest first:
 *
 * ```
 * {"success":true,"errorCode":10000,"result":{"total":2116,"jobList":[{"jobId":"6abe…","tabCategory":["newgrad:us:swe"],
 *  "postedAt":1792859280000,"properties":{"title":"…","company":"…","location":"…","salary":"$150000-$168000/yr",
 *  "workModel":"Hybrid","industry":["SaaS"],"companySize":"501-1000","qualifications":"1. …","expLevel":null,
 *  "h1bSponsored":"Not Sure", …}}]}}
 * ```
 *
 * It is undocumented and internal (robots.txt disallows `/swan/`): Explore calls it only when the page opens with
 * no cache and on Refresh, for one category, at most `EXPLORE_MAX_ROWS` rows. The answer is untrusted like the
 * README: every field is checked, capped and dropped (or the row skipped) when it is not what it should be.
 */

/** The endpoint, without its query. */
export const JOBRIGHT_API_URL = 'https://jobright.ai/swan/mini-sites/list'

/** Rows asked for per request: two requests reach the cap. */
export const PAGE_SIZE = 500

/** Oldest `postedAt` taken as real: 2020-01-01. */
const MIN_POSTED = Date.UTC(2020, 0, 1)

/** Whitespace squashed, tags removed, length capped; `''` for anything but a string. */
function text(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Like `text`, but newlines kept (the qualifications are a numbered list, one per line). */
function lines(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => text(l, max))
    .filter(Boolean)
    .join('\n')
    .slice(0, max)
}

export interface ApiPage {
  /** The category's size, as the API says it; `null` when it does not. */
  total: number | null
  /** How many rows the API sent (parseable or not), to know whether another page exists. */
  received: number
  jobs: ExploreJob[]
}

export interface ApiParseOptions {
  /** Origin of the stored job links: `https://jobright.ai`, or the e2e mock's. */
  origin?: string
  /** Hosts a job link may point to (the e2e mock adds its own). */
  hosts?: readonly string[]
  now?: Date
}

/** One `jobList` entry as an `ExploreJob`, or `null` when it is malformed. */
export function apiRow(raw: unknown, opts: ApiParseOptions = {}): ExploreJob | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const p = (typeof r.properties === 'object' && r.properties !== null ? r.properties : null) as Record<string, unknown> | null
  if (!p || typeof r.jobId !== 'string' || !JOBRIGHT_ID_PATTERN.test(r.jobId)) return null
  const now = (opts.now ?? new Date()).getTime()
  const posted = r.postedAt
  // Milliseconds since 1970, not before 2020 and not more than two days ahead (time zones, clock skew).
  if (typeof posted !== 'number' || !Number.isFinite(posted) || posted < MIN_POSTED || posted > now + 2 * 86_400_000) return null
  const title = text(p.title, 300)
  const company = text(p.company, 300)
  if (!title || !company) return null
  const origin = opts.origin ?? 'https://jobright.ai'
  const url = `${origin}/jobs/info/${r.jobId}`
  if (jobrightId(url, opts.hosts ?? JOBRIGHT_HOSTS) !== r.jobId) return null
  const job: ExploreJob = {
    id: r.jobId,
    company,
    // The API gives no company site.
    companyUrl: null,
    title,
    url,
    location: text(p.location, 300),
    workModel: typeof p.workModel === 'string' ? workModelOf(p.workModel) : null,
    postedAt: localDay(new Date(posted))
  }
  const salary = text(p.salary, 120)
  if (salary) job.salary = salary
  const qualifications = lines(p.qualifications, 4000)
  if (qualifications) job.qualifications = qualifications
  if (H1B_VALUES.includes(p.h1bSponsored as H1bSponsored)) job.h1b = p.h1bSponsored as H1bSponsored
  if (Array.isArray(p.industry)) {
    const industry = [...new Set(p.industry.map((i) => text(i, 60)).filter(Boolean))].slice(0, 10)
    if (industry.length > 0) job.industry = industry
  }
  const size = text(p.companySize, 40)
  if (size) job.companySize = size
  const level = text(p.expLevel, 60)
  if (level) job.expLevel = level
  return job
}

/**
 * One answer of the API: its rows that parse, and its total. Throws when the answer is not a successful
 * list (`success` not `true`, no `result.jobList` array): the caller falls back to the README.
 */
export function parseApiPage(json: unknown, opts: ApiParseOptions = {}): ApiPage {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  if (o.success !== true) {
    const code = typeof o.errorCode === 'number' && Number.isFinite(o.errorCode) ? ` (error ${o.errorCode})` : ''
    throw new Error(`The newgrad-jobs API refused the request${code}.`)
  }
  const result = (typeof o.result === 'object' && o.result !== null ? o.result : {}) as Record<string, unknown>
  if (!Array.isArray(result.jobList)) throw new Error('The newgrad-jobs API answered in a shape Huntgry does not know.')
  const total = typeof result.total === 'number' && Number.isInteger(result.total) && result.total >= 0 ? result.total : null
  const jobs = result.jobList.map((r) => apiRow(r, opts)).filter((j): j is ExploreJob => j !== null)
  return { total, received: result.jobList.length, jobs }
}

export interface ApiFetchDeps extends ApiParseOptions {
  /** `JOBRIGHT_API_URL`, or the e2e mock's. */
  apiUrl: string
  postJson(url: string, body: unknown): Promise<unknown>
  /** The public-URL guard; checked on each page's URL. */
  refusal(url: string): Promise<string | null>
  /** Rows per refresh; `EXPLORE_MAX_ROWS` unless a test says otherwise. */
  maxRows?: number
  pageSize?: number
}

/** The URL of one page. */
export function pageUrl(apiUrl: string, position: number, count: number): string {
  const u = new URL(apiUrl)
  u.searchParams.set('position', String(position))
  u.searchParams.set('count', String(count))
  return u.toString()
}

/**
 * The category's newest rows, page by page, stopping at the cap, at a short page or at the total. A failed first
 * page throws (the caller falls back); a failed later page keeps the rows already read. Throws when no row parses.
 */
export async function fetchApiList(category: string, deps: ApiFetchDeps): Promise<{ jobs: ExploreJob[]; total: number | null }> {
  const max = deps.maxRows ?? EXPLORE_MAX_ROWS
  const size = Math.min(deps.pageSize ?? PAGE_SIZE, max)
  const jobs: ExploreJob[] = []
  const seen = new Set<string>()
  let total: number | null = null
  for (let position = 0; position < max; position += size) {
    const url = pageUrl(deps.apiUrl, position, Math.min(size, max - position))
    let page: ApiPage
    try {
      const refusal = await deps.refusal(url)
      if (refusal) throw new Error(refusal)
      page = parseApiPage(await deps.postJson(url, { category }), deps)
    } catch (err) {
      if (position === 0) throw err
      break
    }
    total = page.total ?? total
    for (const j of page.jobs) {
      if (seen.has(j.id) || jobs.length >= max) continue
      seen.add(j.id)
      jobs.push(j)
    }
    if (page.received < Math.min(size, max - position) || (total !== null && position + size >= total)) break
  }
  if (jobs.length === 0) throw new Error('The newgrad-jobs API sent no job Huntgry could read.')
  return { jobs, total }
}
