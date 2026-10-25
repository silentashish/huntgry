import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_EXPLORE_CATEGORY,
  H1B_VALUES,
  JOBRIGHT_ID_PATTERN,
  savedJobId,
  WORK_MODELS,
  type ExploreJob,
  type ExploreList,
  type ExploreSource
} from '@shared/explore-types'
import { toJob } from '@shared/explore-score'
import type { Job } from '@shared/jobs-types'
import { HUNTGRY_DIR } from '../workspace/constants'
import { findCanonical, readJob, saveJob } from '../jobs/store'
import { fetchApiList } from './api'
import { resolveEmployerLink, type LinkDeps } from './employer-link'
import { JOBRIGHT_HOSTS, jobrightId, parseReadme } from './parse'

export { fetchReadme, postJson } from './fetch'
export { toJob } from '@shared/explore-score'

/**
 * Explore (#142, #169): Jobright's jobs of one category, from the newgrad-jobs API, fetched only when the
 * workspace has no copy of that category yet or the user clicks Refresh, and cached in
 * `<workspace>/.huntgry/explore/<category>.json` so the page opens at once and offline. When the API fails (an
 * HTTP error, a timeout, `success: false`, no row that parses), the default category falls back to the GitHub
 * README, and the list says so. Adding a row saves it through the jobs store, so it is an ordinary saved job.
 */

export interface ExploreDeps {
  /** The API's URL: the constant, or the e2e mock server's (see `exploreSource`). */
  apiUrl: string
  /** The README's URL: the constant, or the e2e mock server's. */
  readmeUrl: string
  /** Hosts a row's job link may point to. */
  hosts: readonly string[]
  /** POSTs a JSON body to the API and parses the answer; throws with a message the page can show. */
  postJson(url: string, body: unknown): Promise<unknown>
  /** Fetches the README as text; throws with a message the page can show. */
  fetchText(url: string): Promise<string>
  /** Why a URL may not be fetched or opened (the public-URL guard), or `null`. */
  refusal(url: string): Promise<string | null>
  /**
   * The employer link of a newly added job (#146): looked up only while `connected()` (the Jobright sign-in as
   * last seen), so nothing is loaded for a user who never connected. Absent in tests of the list itself.
   */
  link?: LinkDeps & { connected(): Promise<boolean> }
  now?: () => Date
  /** Rows per refresh and per API page; the defaults unless a test says otherwise. */
  maxRows?: number
  pageSize?: number
}

interface CacheFile extends ExploreList {
  /** The URL the list was read from: a cache of the mock's list is never served for the real one. */
  sourceUrl: string
}

export const exploreDir = (workspace: string) => join(workspace, HUNTGRY_DIR, 'explore')
/** One file per category: `newgrad.us.swe.json`. */
export const cachePath = (workspace: string, category = DEFAULT_EXPLORE_CATEGORY) =>
  join(exploreDir(workspace), `${category.replace(/:/g, '.')}.json`)

const DAY = /^\d{4}-\d{2}-\d{2}$/

const optionalText = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max)

/**
 * A cached row, checked again on read (the file is in the user's folder and may have been edited): its URL
 * must be the posting page of its own id on an allowed host, as the parsers wrote it, and the API's fields
 * must have their types.
 */
function validRow(r: unknown, hosts: readonly string[]): r is ExploreJob {
  if (typeof r !== 'object' || r === null) return false
  const j = r as Record<string, unknown>
  return (
    typeof j.id === 'string' &&
    JOBRIGHT_ID_PATTERN.test(j.id) &&
    typeof j.title === 'string' &&
    typeof j.company === 'string' &&
    typeof j.location === 'string' &&
    typeof j.url === 'string' &&
    jobrightId(j.url, hosts) === j.id &&
    (j.companyUrl === null || typeof j.companyUrl === 'string') &&
    (j.workModel === null || WORK_MODELS.includes(j.workModel as never)) &&
    typeof j.postedAt === 'string' &&
    DAY.test(j.postedAt) &&
    optionalText(j.salary, 120) &&
    optionalText(j.qualifications, 4000) &&
    (j.h1b === undefined || H1B_VALUES.includes(j.h1b as never)) &&
    (j.industry === undefined ||
      (Array.isArray(j.industry) && j.industry.length <= 10 && j.industry.every((i) => typeof i === 'string' && i.length <= 60))) &&
    optionalText(j.companySize, 40) &&
    optionalText(j.expLevel, 60)
  )
}

type CacheDeps = Pick<ExploreDeps, 'apiUrl' | 'readmeUrl' | 'hosts'>

/** The URL a list from `source` is read from. */
const urlOf = (source: ExploreSource, deps: CacheDeps) => (source === 'api' ? deps.apiUrl : deps.readmeUrl)

/** The cached list of `category`, or `null` when there is none (or it was fetched from another URL). */
export async function readCache(workspace: string, category: string, deps: CacheDeps): Promise<ExploreList | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(cachePath(workspace, category), 'utf8'))
  } catch {
    return null
  }
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<CacheFile>
  if (c.category !== category || (c.source !== 'api' && c.source !== 'readme') || !Array.isArray(c.jobs)) return null
  if (c.sourceUrl !== urlOf(c.source, deps)) return null
  if (c.source === 'readme' && category !== DEFAULT_EXPLORE_CATEGORY) return null
  const list: ExploreList = {
    jobs: c.jobs.filter((j) => validRow(j, deps.hosts)),
    fetchedAt: typeof c.fetchedAt === 'string' ? c.fetchedAt : null,
    category,
    source: c.source
  }
  if (typeof c.total === 'number' && Number.isInteger(c.total) && c.total >= 0) list.total = c.total
  if (typeof c.fallbackReason === 'string') list.fallbackReason = c.fallbackReason.slice(0, 500)
  return list
}

async function writeCache(workspace: string, data: CacheFile): Promise<void> {
  await mkdir(exploreDir(workspace), { recursive: true })
  const path = cachePath(workspace, data.category)
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** The cached list of `category`; fetched (and cached) when the workspace has none yet. */
export async function listExplore(workspace: string, category: string, deps: ExploreDeps): Promise<ExploreList> {
  return (await readCache(workspace, category, deps)) ?? refreshExplore(workspace, category, deps)
}

/** Origin of the stored job links: Jobright's canonical one, or a test host's own. */
const linkOrigin = (apiUrl: string) => {
  const u = new URL(apiUrl)
  return JOBRIGHT_HOSTS.includes(u.host.toLowerCase()) ? 'https://jobright.ai' : u.origin
}

/** The README's rows: the fallback of the default category. Throws when it cannot be read or has no row. */
async function readmeList(deps: ExploreDeps, now: Date): Promise<ExploreJob[]> {
  const refusal = await deps.refusal(deps.readmeUrl)
  if (refusal) throw new Error(refusal)
  const jobs = parseReadme(await deps.fetchText(deps.readmeUrl), { today: now, hosts: deps.hosts })
  if (jobs.length === 0) throw new Error('The Jobright list had no jobs Huntgry could read. Try again later.')
  return jobs
}

/**
 * Fetches `category` again from the API (the README when the API fails and the category is the default one) and
 * replaces its cache. A failed fetch leaves the cache as it was and says why.
 */
export async function refreshExplore(workspace: string, category: string, deps: ExploreDeps): Promise<ExploreList> {
  const now = deps.now?.() ?? new Date()
  let list: CacheFile
  try {
    const { jobs, total } = await fetchApiList(category, {
      apiUrl: deps.apiUrl,
      postJson: deps.postJson,
      refusal: deps.refusal,
      origin: linkOrigin(deps.apiUrl),
      hosts: deps.hosts,
      now,
      maxRows: deps.maxRows,
      pageSize: deps.pageSize
    })
    list = { category, source: 'api', sourceUrl: deps.apiUrl, fetchedAt: now.toISOString(), jobs, ...(total !== null ? { total } : {}) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (category !== DEFAULT_EXPLORE_CATEGORY) throw new Error(reason)
    let jobs: ExploreJob[]
    try {
      jobs = await readmeList(deps, now)
    } catch (readmeErr) {
      throw new Error(`${reason} The GitHub list could not be read either: ${readmeErr instanceof Error ? readmeErr.message : String(readmeErr)}`)
    }
    list = { category, source: 'readme', sourceUrl: deps.readmeUrl, fetchedAt: now.toISOString(), jobs, fallbackReason: reason.slice(0, 500) }
  }
  await writeCache(workspace, list)
  const { sourceUrl: _, ...shown } = list
  return shown
}

/**
 * Saves a listed job to the Jobs page. Idempotent: a job already saved (by this id, or merged into another
 * board's copy) is returned as it is, never written again, so a description fetched since is kept. A new
 * job's link becomes the employer's posting while Jobright is connected and gives one (#146); adding never
 * fails because of that lookup.
 */
export async function addExplore(workspace: string, id: string, category: string, deps: ExploreDeps): Promise<Job> {
  const existing = await findCanonical(workspace, savedJobId(id))
  if (existing) return existing
  const list = await readCache(workspace, category, deps)
  const row = list?.jobs.find((j) => j.id === id)
  if (!row) throw new Error('This job is no longer on the Jobright list. Refresh and try again.')
  const refusal = await deps.refusal(row.url)
  if (refusal) throw new Error(refusal)
  const saved = await saveJob(workspace, toJob(row, deps.now?.() ?? new Date()))
  if (deps.link && (await deps.link.connected().catch(() => false))) await resolveEmployerLink(workspace, saved.id, deps.link)
  return (await findCanonical(workspace, saved.id)) ?? (await readJob(workspace, saved.id)) ?? saved
}
