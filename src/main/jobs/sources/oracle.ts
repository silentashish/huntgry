import type { Job, JobSourceId, WorkplaceType } from '@shared/jobs-types'
import { isLoopbackUrl } from '../../cli/dev-urls'
import type { LoadResult } from '../loader'
import type { JsonFetcher } from '../public-json'
import { htmlToText } from '../text'
import { isoDate, parsePosting, POSTING_EXTRACT, urlJobId, withoutTracking, type PageData } from './posting'

/**
 * Oracle HCM Cloud Recruiting "Candidate Experience" postings (#191), on the employer's own domain
 * (`careers.americanexpress.com/en/sites/CX_1/job/26014651`) or on Oracle's
 * (`<tenant>.fa.<dc>.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26014651`). The page is a
 * single-page app with no JSON-LD and no description; the job comes from the tenant's public requisition API on
 * its Oracle host, which a custom domain's page names (`<base data-apibaseurl>`). That host is untrusted page
 * content: only an https `*.oraclecloud.com` host is called.
 */

export interface OracleRef {
  siteNumber: string
  jobId: string
  /** `https://<tenant>.oraclecloud.com` when the URL is on Oracle's host already; else it is read from the page. */
  apiOrigin: string | null
}

const ORACLE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.oraclecloud\.com$/i
const POSTING_PATH = /\/sites\/([\w-]{1,40})\/(?:job|requisitions\/(?:preview|job))\/(\d{1,20})\/?$/

/** The site and job of a Candidate Experience posting URL (any language prefix, any query), else `null`. */
export function oracleRef(url: string): OracleRef | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const m = POSTING_PATH.exec(u.pathname)
  if (!m) return null
  const onOracle = u.protocol === 'https:' && ORACLE_HOST.test(u.hostname)
  return { siteNumber: m[1], jobId: m[2], apiOrigin: onOracle ? `https://${u.hostname.toLowerCase()}` : null }
}

/**
 * The API origin a page names, when it may be called: https, an `*.oraclecloud.com` host, the default port, no
 * user info. `allowLoopback` is the dev-only mock-server allowance (`localUrlsAllowed`).
 */
export function oracleApiOrigin(candidate: string, allowLoopback = false): string | null {
  let u: URL
  try {
    u = new URL(candidate)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (allowLoopback && isLoopbackUrl(u.href)) return u.origin
  if (u.protocol !== 'https:' || u.port !== '' || !ORACLE_HOST.test(u.hostname)) return null
  return `https://${u.hostname.toLowerCase()}`
}

/** The requisition-details API call the Candidate Experience app makes for a job. */
export function requisitionUrl(origin: string, ref: OracleRef): string {
  const finder = `ById;Id=%22${ref.jobId}%22,siteNumber=${encodeURIComponent(ref.siteNumber)}`
  return `${origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`
}

/** A posting page read for Oracle: the usual posting data, its Open Graph tags and the Oracle hosts it names. */
export interface OraclePage extends PageData {
  og?: { title?: string; description?: string; siteName?: string }
  oracleHosts?: string[]
}

/** Runs in the page: `POSTING_EXTRACT`'s data, plus the Open Graph tags and the API hosts (base tag first). */
export const ORACLE_PAGE_EXTRACT = `(() => {
  const page = JSON.parse(${POSTING_EXTRACT})
  const meta = (p) => {
    const m = document.querySelector('meta[property="' + p + '"]')
    return m ? (m.getAttribute('content') || '').trim() : ''
  }
  const hosts = []
  const base = document.querySelector('[data-apibaseurl]')
  if (base) hosts.push(base.getAttribute('data-apibaseurl') || '', base.getAttribute('data-fahosturl') || '')
  const html = document.documentElement ? document.documentElement.outerHTML.slice(0, 500000) : ''
  for (const m of html.matchAll(/https:\\/\\/[a-z0-9.-]+\\.oraclecloud\\.com(?::\\d+)?/gi)) {
    if (hosts.length >= 8) break
    hosts.push(m[0])
  }
  const og = { title: meta('og:title'), description: meta('og:description'), siteName: meta('og:site_name') }
  return JSON.stringify({ ...page, og, oracleHosts: hosts.filter(Boolean) })
})()`

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** The requisition in an API answer, `null` when there is none (the job closed or never was on that site). */
export function requisitionOf(data: unknown, jobId: string): Obj | null {
  const items = obj(data).items
  if (!Array.isArray(items)) return null
  return items.map(obj).find((i) => String(i.Id ?? '') === jobId) ?? null
}

function workplaceOf(r: Obj): WorkplaceType | '' {
  const w = `${str(r.WorkplaceTypeCode)} ${str(r.WorkplaceType)}`
  if (/remote/i.test(w)) return 'Remote'
  if (/hybrid/i.test(w)) return 'Hybrid'
  if (/on.?site|office/i.test(w)) return 'Onsite'
  return ''
}

/** The description, then responsibilities and qualifications, as the Candidate Experience app shows them. */
function descriptionOf(r: Obj): string {
  let text = htmlToText(str(r.ExternalDescriptionStr))
  for (const [heading, field] of [
    ['Responsibilities', 'ExternalResponsibilitiesStr'],
    ['Qualifications', 'ExternalQualificationsStr']
  ] as const) {
    const part = htmlToText(str(r[field]))
    // Some tenants put the whole posting in the description and repeat the parts.
    if (!part || text.includes(part.slice(0, 80))) continue
    text = text ? `${text}\n\n## ${heading}\n\n${part}` : part
  }
  return text
}

/** The pay a requisition's flexfields give (`Salary Range: $123000 - $215250 annually …`), else empty. */
function salaryOf(r: Obj): string {
  const fields = Array.isArray(r.requisitionFlexFields) ? r.requisitionFlexFields.map(obj) : []
  const field = fields.find((f) => /salary|pay range|compensation/i.test(str(f.Prompt)))
  return field ? str(field.Value).slice(0, 200) : ''
}

/** A job from a requisition; `null` without a title. */
export function requisitionJob(
  r: Obj,
  ctx: { url: string; source: JobSourceId; company: string; now?: Date }
): Job | null {
  const title = str(r.Title)
  if (!title) return null
  const secondary = Array.isArray(r.secondaryLocations) ? r.secondaryLocations.map((l) => str(obj(l).Name)) : []
  const locations = [...new Set([str(r.PrimaryLocation), ...secondary].filter(Boolean))]
  const workplaceType = workplaceOf(r)
  const description = descriptionOf(r)
  const id = urlJobId(ctx.url)
  return {
    id: `${ctx.source}:${id}`,
    source: ctx.source,
    sourceId: id,
    title,
    company: ctx.company || str(r.LegalEmployer),
    location: locations.join(' / ') || (workplaceType === 'Remote' ? 'Remote' : ''),
    remote: workplaceType === 'Remote',
    salary: salaryOf(r),
    postedAt: isoDate(str(r.ExternalPostedStartDate)),
    url: ctx.url,
    boardUrl: null,
    description,
    descriptionComplete: description.length > 0,
    tags: [],
    fetchedAt: (ctx.now ?? new Date()).toISOString(),
    ...(workplaceType ? { workplaceType } : {})
  }
}

/** The page's Open Graph title and (truncated) description: a job marked incomplete, `null` without a title. */
export function ogPosting(page: OraclePage, ctx: { url: string; source: JobSourceId; now?: Date }): Job | null {
  const og = obj(page.og)
  const title = str(og.title)
  if (!title) return null
  const description = str(og.description)
  const id = urlJobId(ctx.url)
  return {
    id: `${ctx.source}:${id}`,
    source: ctx.source,
    sourceId: id,
    title,
    company: str(og.siteName),
    location: '',
    remote: false,
    salary: '',
    postedAt: null,
    url: ctx.url,
    boardUrl: null,
    description,
    descriptionComplete: false,
    tags: [],
    fetchedAt: (ctx.now ?? new Date()).toISOString()
  }
}

const PASTE = 'Paste the job description instead.'

/**
 * Reads a Candidate Experience posting: the page (for its Oracle host, company and Open Graph tags), then the job
 * from the requisition API. When the API cannot be reached, the page's Open Graph title and description are the
 * job, marked incomplete. Throws a message that says what happened and offers Paste when there is no job; `null`
 * when the page turns out not to be Oracle's and has no posting either.
 */
export async function readOraclePosting(
  url: string,
  ref: OracleRef,
  deps: {
    source: JobSourceId
    load: (url: string, extract: string) => Promise<LoadResult>
    json?: JsonFetcher
    now?: Date
  }
): Promise<Job | null> {
  const res = await deps.load(url, ORACLE_PAGE_EXTRACT)
  const page = res.status === 'ok' ? (res.data as OraclePage) : null
  const hosts = Array.isArray(page?.oracleHosts) ? page.oracleHosts : []
  const origin =
    ref.apiOrigin ??
    hosts.map((h) => (typeof h === 'string' ? oracleApiOrigin(h, deps.json?.allowLoopback) : null)).find(Boolean) ??
    null
  if (!origin) {
    if (res.status === 'blocked') throw new Error(`${res.message} ${PASTE}`)
    if (res.status === 'error') throw new Error(res.message)
    // Not an Oracle site after all (the path is only similar): the page is read like any posting.
    return parsePosting(res.data as PageData, deps.source, deps.now)
  }
  const ctx = { url: withoutTracking(url), source: deps.source, now: deps.now }
  const company = str(obj(page?.og).siteName)
  // Oracle's pages always carry Open Graph tags; any other page is read like any posting.
  const fallback = page ? (ogPosting(page, ctx) ?? parsePosting(page, deps.source, deps.now)) : null
  const api = deps.json
    ? await deps.json(requisitionUrl(origin, ref))
    : ({ status: 'error', message: 'The job service was not called.' } as const)
  // An answer that is not a list of requisitions is a service that did not answer, not a closed job.
  const listed = api.status === 'ok' && Array.isArray(obj(api.data).items)
  if (listed) {
    const r = requisitionOf(api.data, ref.jobId)
    if (!r) throw new Error(`This job is no longer posted on ${company || 'the careers site'}: it has probably closed. ${PASTE}`)
    const job = requisitionJob(r, { ...ctx, company })
    if (job) return job
  }
  if (fallback) return fallback
  const why = api.status === 'error' ? api.message : listed ? 'Its answer had no job title.' : 'Its answer was not a job list.'
  throw new Error(`The careers site's job service could not be reached. ${why} ${PASTE}`)
}
