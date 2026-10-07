import { createHash } from 'node:crypto'
import type { Job } from '@shared/jobs-types'
import type { LoadResult } from './loader'
import { parsePosting, POSTING_EXTRACT, type PageData } from './sources/posting'
import { findCanonical, listJobs, readJob, saveJob, writeJobFile } from './store'

/** Loads a page and reads data from it; the hidden-window loader in the app, a stub in tests. */
export type Loader = (url: string, extract: string) => Promise<LoadResult>

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
 * Full description for a saved job, from the employer's posting page of the
 * first copy of the job that loads and reads. Jobs saved from Indeed before
 * board search was removed (#78) cannot: its job pages are behind a human
 * check. The description is saved to the canonical record.
 */
export async function fetchDetails(workspace: string, id: string, load: Loader): Promise<Job> {
  const job = await findCanonical(workspace, id)
  if (!job) throw new Error('This job is no longer saved.')
  if (job.descriptionComplete) return job
  // A job seen on several boards: the canonical copy may be Indeed's while another board's copy has a loadable URL.
  const copies = [job, ...(await Promise.all((job.aliases ?? []).map((a) => readJob(workspace, a))))]
  const fetchable = copies.filter((c): c is Job => !!c && c.source !== 'indeed' && /^https?:\/\//i.test(c.url))
  if (fetchable.length === 0) {
    throw new Error(
      'Indeed shows full job descriptions only after a human check. Open the posting and paste the description.'
    )
  }
  // Try each loadable copy in turn until one gives a complete posting; a longer partial one is the fallback.
  let posting: Job | null = null
  let failure = ''
  for (const copy of fetchable) {
    let res: LoadResult
    try {
      res = await load(copy.url, POSTING_EXTRACT)
    } catch (err) {
      // Keep going: a later copy may load, and a partial description found so far is still saved.
      failure = `${err instanceof Error ? err.message : String(err)} The summary from the job board is kept; open the posting to read it all.`
      continue
    }
    if (res.status !== 'ok') {
      failure = `${res.message} The summary from the job board is kept; open the posting to read it all.`
      continue
    }
    const parsed = parsePosting(res.data as PageData, copy.source)
    if (parsed?.descriptionComplete) {
      posting = parsed
      break
    }
    // An incomplete posting is only worth keeping if it says more than what is saved already.
    const best = posting?.description.length ?? job.description.length
    if (parsed && parsed.description.length > best) posting = parsed
    else if (!posting) failure = "The employer's page did not have a readable description. Open the posting to read it."
  }
  if (!posting) throw new Error(failure)
  await saveJob(workspace, {
    ...((await readJob(workspace, job.id)) ?? job),
    description: posting.description,
    descriptionComplete: posting.descriptionComplete,
    salary: job.salary || posting.salary,
    location: job.location || posting.location
  })
  return (await findCanonical(workspace, job.id)) ?? job
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
  const canonical = await findCanonical(workspace, id)
  if (!canonical) throw new Error('This job is no longer saved.')
  const now = new Date().toISOString()
  const tailoredAt = patch.tailored === true ? now : undefined
  // The same state goes to every copy of the job, so the canonical view stays consistent.
  for (const fileId of [canonical.id, ...(canonical.aliases ?? [])]) {
    const raw = await readJob(workspace, fileId)
    if (!raw) continue
    const next: Job = { ...raw }
    if (typeof patch.dismissed === 'boolean') {
      // When it was dismissed: the Board drops an archived card a week later (#85).
      if (patch.dismissed && !raw.dismissed) next.dismissedAt = now
      if (!patch.dismissed) delete next.dismissedAt
      next.dismissed = patch.dismissed
    }
    if (tailoredAt) next.tailoredAt = tailoredAt
    await writeJobFile(workspace, next)
  }
  return (await findCanonical(workspace, canonical.id)) ?? canonical
}

export { listJobs }
