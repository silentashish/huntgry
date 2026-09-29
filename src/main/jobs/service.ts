import { createHash } from 'node:crypto'
import type { Job, JobQuery, SearchResult, SearchSource, SourceResult } from '@shared/jobs-types'
import type { LoadResult } from './loader'
import { HIRINGCAFE_EXTRACT, hiringCafeSearchUrl, matchesLocation, parseHiringCafeHits } from './sources/hiringcafe'
import { INDEED_EXTRACT, indeedSearchUrl, parseIndeedCards } from './sources/indeed'
import { parsePosting, POSTING_EXTRACT, type PageData } from './sources/posting'
import { listJobs, readJob, recordSearch, saveJob, saveJobs, writeJobFile } from './store'

/** Loads a page and reads data from it; the hidden-window loader in the app, a stub in tests. */
export type Loader = (url: string, extract: string) => Promise<LoadResult>

const MAX_PER_SOURCE = 60

const SOURCES: Record<
  SearchSource,
  { url(q: JobQuery): string; extract: string; parse(data: unknown, q: JobQuery): Job[] }
> = {
  'hiring.cafe': {
    url: hiringCafeSearchUrl,
    extract: HIRINGCAFE_EXTRACT,
    parse: (d, q) => parseHiringCafeHits(d).filter((j) => matchesLocation(j, q.location))
  },
  indeed: { url: indeedSearchUrl, extract: INDEED_EXTRACT, parse: (d) => parseIndeedCards(d) }
}

export function validateQuery(input: unknown): JobQuery {
  const q = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const keywords = typeof q.keywords === 'string' ? q.keywords.trim().slice(0, 200) : ''
  if (!keywords) throw new Error('Enter keywords to search for.')
  const sources = Array.isArray(q.sources)
    ? q.sources.filter((s): s is SearchSource => s === 'hiring.cafe' || s === 'indeed')
    : []
  if (sources.length === 0) throw new Error('Pick at least one job board.')
  return {
    keywords,
    location: typeof q.location === 'string' ? q.location.trim().slice(0, 200) : '',
    remoteOnly: q.remoteOnly === true,
    sources: [...new Set(sources)]
  }
}

/** Searches each selected board in turn, saves what they return, and reports per board. */
export async function searchJobs(workspace: string, query: JobQuery, load: Loader): Promise<SearchResult> {
  await recordSearch(workspace, query)
  const sources: SourceResult[] = []
  const found: Job[] = []
  for (const s of query.sources) {
    const src = SOURCES[s]
    const res = await load(src.url(query), src.extract)
    if (res.status !== 'ok') {
      sources.push({ source: s, status: res.status, count: 0, message: res.message })
      continue
    }
    let jobs = src.parse(res.data, query).slice(0, MAX_PER_SOURCE)
    if (query.remoteOnly) jobs = jobs.filter((j) => j.remote)
    const saved = await saveJobs(workspace, jobs)
    found.push(...saved)
    sources.push({
      source: s,
      status: 'ok',
      count: saved.length,
      message: saved.length === 0 ? 'No results for this search.' : undefined
    })
  }
  return { jobs: found, sources }
}

/** Fetches a posting page and saves it as a job. */
export async function addByUrl(workspace: string, url: string, load: Loader): Promise<Job> {
  if (!/^https?:\/\//i.test(url)) throw new Error('The URL must start with http:// or https://.')
  const res = await load(url, POSTING_EXTRACT)
  if (res.status === 'blocked') throw new Error(`${res.message} Paste the job description instead.`)
  if (res.status === 'error') throw new Error(res.message)
  const job = parsePosting(res.data as PageData, 'url')
  if (!job) throw new Error('No job posting was found on that page. Paste the description instead.')
  return saveJob(workspace, { ...job, url })
}

/**
 * Full description for a saved job. hiring.cafe: the employer's posting page.
 * Indeed: its job pages are behind a human check, so this reports that.
 */
export async function fetchDetails(workspace: string, id: string, load: Loader): Promise<Job> {
  const job = await readJob(workspace, id)
  if (!job) throw new Error('This job is no longer saved.')
  if (job.descriptionComplete) return job
  if (job.source === 'indeed') {
    throw new Error(
      'Indeed shows full job descriptions only after a human check. Open the posting and paste the description.'
    )
  }
  const res = await load(job.url, POSTING_EXTRACT)
  if (res.status !== 'ok')
    throw new Error(`${res.message} The summary from the job board is kept; open the posting to read it all.`)
  const posting = parsePosting(res.data as PageData, job.source)
  // A complete posting always wins; otherwise only take it if it says more than the board's summary.
  if (!posting || (!posting.descriptionComplete && posting.description.length <= job.description.length)) {
    throw new Error("The employer's page did not have a readable description. Open the posting to read it.")
  }
  return saveJob(workspace, {
    ...job,
    description: posting.description,
    descriptionComplete: posting.descriptionComplete,
    salary: job.salary || posting.salary,
    location: job.location || posting.location
  })
}

export async function addPasted(workspace: string, input: unknown): Promise<Job> {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const text = typeof p.text === 'string' ? p.text.trim().slice(0, 200_000) : ''
  if (text.length < 50) throw new Error('Paste the full job description.')
  const title =
    (typeof p.title === 'string' && p.title.trim()) ||
    text
      .split('\n')[0]
      .replace(/^#+\s*/, '')
      .slice(0, 140)
  const url = typeof p.url === 'string' && /^https?:\/\//i.test(p.url.trim()) ? p.url.trim() : ''
  const sourceId = createHash('sha256')
    .update(url || text)
    .digest('hex')
    .slice(0, 16)
  return saveJob(workspace, {
    id: `pasted:${sourceId}`,
    source: 'pasted',
    sourceId,
    title,
    company: typeof p.company === 'string' ? p.company.trim().slice(0, 200) : '',
    location: '',
    remote: /\bremote\b/i.test(text.slice(0, 2000)),
    salary: '',
    postedAt: null,
    url,
    boardUrl: null,
    description: text,
    descriptionComplete: true,
    tags: [],
    fetchedAt: new Date().toISOString()
  })
}

export async function updateJob(
  workspace: string,
  id: string,
  patch: { dismissed?: boolean; tailored?: boolean }
): Promise<Job> {
  const job = await readJob(workspace, id)
  if (!job) throw new Error('This job is no longer saved.')
  const next: Job = { ...job }
  if (typeof patch.dismissed === 'boolean') next.dismissed = patch.dismissed
  if (patch.tailored === true) next.tailoredAt = new Date().toISOString()
  return writeJobFile(workspace, next)
}

export { listJobs }
