import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JOBRIGHT_ID_PATTERN, savedJobId, WORK_MODELS, type ExploreJob, type ExploreList } from '@shared/explore-types'
import type { Job, WorkplaceType } from '@shared/jobs-types'
import { HUNTGRY_DIR } from '../workspace/constants'
import { findCanonical, readJob, saveJob } from '../jobs/store'
import { JOBRIGHT_HOSTS, jobrightId, parseReadme } from './parse'

/**
 * Explore (#142): Jobright's new-grad list, fetched from GitHub only when the workspace has no copy yet or
 * the user clicks Refresh, cached in `<workspace>/.huntgry/explore/jobright.json` so the page opens at once
 * and offline. Adding a row saves it through the jobs store, so it is an ordinary saved job afterwards.
 */

export interface ExploreDeps {
  /** The README's URL: the constant, or the e2e mock server's (see `exploreSource`). */
  sourceUrl: string
  /** Hosts a row's job link may point to. */
  hosts: readonly string[]
  /** Fetches the README as text; throws with a message the page can show. */
  fetchText(url: string): Promise<string>
  /** Why a URL may not be fetched or opened (the public-URL guard), or `null`. */
  refusal(url: string): Promise<string | null>
  now?: () => Date
}

interface CacheFile extends ExploreList {
  source: string
}

export const exploreDir = (workspace: string) => join(workspace, HUNTGRY_DIR, 'explore')
export const cachePath = (workspace: string) => join(exploreDir(workspace), 'jobright.json')

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A cached row, checked again on read (the file is in the user's folder and may have been edited): its URL
 * must be the posting page of its own id on an allowed host, as the parser wrote it.
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
    DAY.test(j.postedAt)
  )
}

/** The cached list for `source`, or `null` when there is none (or it was fetched from another URL). */
export async function readCache(
  workspace: string,
  source: string,
  hosts: readonly string[] = JOBRIGHT_HOSTS
): Promise<ExploreList | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(cachePath(workspace), 'utf8'))
  } catch {
    return null
  }
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<CacheFile>
  if (c.source !== source || !Array.isArray(c.jobs)) return null
  return { jobs: c.jobs.filter((j) => validRow(j, hosts)), fetchedAt: typeof c.fetchedAt === 'string' ? c.fetchedAt : null }
}

async function writeCache(workspace: string, data: CacheFile): Promise<void> {
  await mkdir(exploreDir(workspace), { recursive: true })
  const tmp = `${cachePath(workspace)}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, cachePath(workspace))
}

/** The cached list; fetched (and cached) when the workspace has none yet. */
export async function listExplore(workspace: string, deps: ExploreDeps): Promise<ExploreList> {
  return (await readCache(workspace, deps.sourceUrl, deps.hosts)) ?? refreshExplore(workspace, deps)
}

/** Fetches the README again, parses it and replaces the cache. A failed fetch leaves the cache as it was. */
export async function refreshExplore(workspace: string, deps: ExploreDeps): Promise<ExploreList> {
  const refusal = await deps.refusal(deps.sourceUrl)
  if (refusal) throw new Error(refusal)
  const text = await deps.fetchText(deps.sourceUrl)
  const now = deps.now?.() ?? new Date()
  const jobs = parseReadme(text, { today: now, hosts: deps.hosts })
  if (jobs.length === 0) throw new Error('The Jobright list had no jobs Huntgry could read. Try again later.')
  const list: CacheFile = { source: deps.sourceUrl, fetchedAt: now.toISOString(), jobs }
  await writeCache(workspace, list)
  return { jobs, fetchedAt: list.fetchedAt }
}

const WORKPLACE: Record<NonNullable<ExploreJob['workModel']>, WorkplaceType> = {
  Remote: 'Remote',
  Hybrid: 'Hybrid',
  'On Site': 'Onsite'
}

/** The saved job for a listed one: the Jobright page is its URL until the full posting is fetched. */
export function toJob(e: ExploreJob, now: Date): Job {
  return {
    id: savedJobId(e.id),
    source: 'jobright',
    sourceId: e.id,
    title: e.title,
    company: e.company,
    location: e.location,
    remote: e.workModel === 'Remote',
    salary: '',
    // Noon UTC: the posted day reads the same in every time zone.
    postedAt: `${e.postedAt}T12:00:00.000Z`,
    url: e.url,
    boardUrl: e.url,
    description: '',
    descriptionComplete: false,
    tags: [],
    fetchedAt: now.toISOString(),
    ...(e.workModel ? { workplaceType: WORKPLACE[e.workModel] } : {})
  }
}

/**
 * Saves a listed job to the Jobs page. Idempotent: a job already saved (by this id, or merged into another
 * board's copy) is returned as it is, never written again, so a description fetched since is kept.
 */
export async function addExplore(workspace: string, id: string, deps: ExploreDeps): Promise<Job> {
  const existing = await findCanonical(workspace, savedJobId(id))
  if (existing) return existing
  const list = await readCache(workspace, deps.sourceUrl, deps.hosts)
  const row = list?.jobs.find((j) => j.id === id)
  if (!row) throw new Error('This job is no longer on the Jobright list. Refresh and try again.')
  const refusal = await deps.refusal(row.url)
  if (refusal) throw new Error(refusal)
  const saved = await saveJob(workspace, toJob(row, deps.now?.() ?? new Date()))
  return (await findCanonical(workspace, saved.id)) ?? (await readJob(workspace, saved.id)) ?? saved
}

const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 20_000

/** Plain HTTPS GET of the README from the main process: no cookies, no profile data, nothing but the URL. */
export async function fetchReadme(url: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      credentials: 'omit',
      headers: { accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1' }
    })
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'it did not answer in time' : 'you may be offline'
    throw new Error(`Could not reach GitHub for the Jobright list (${why}).`)
  }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the Jobright list.`)
  const tooLarge = 'The Jobright list is unexpectedly large; not read.'
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) throw new Error(tooLarge)
  // Content-Length may be absent or wrong: count the bytes as they arrive and stop at the cap.
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
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'it did not answer in time' : 'the connection dropped'
    throw new Error(`Could not read the Jobright list from GitHub (${why}).`)
  }
  if (total > MAX_BYTES) {
    await reader.cancel().catch(() => {})
    throw new Error(tooLarge)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}
