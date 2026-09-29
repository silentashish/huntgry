import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Job, JobQuery, SavedSearch } from '@shared/jobs-types'
import { HUNTGRY_DIR } from '../workspace/constants'

/** `<workspace>/.huntgry/jobs/<source>-<id>.json`, one file per job, plus `searches.json`. No database. */

export const jobsDir = (workspace: string) => join(workspace, HUNTGRY_DIR, 'jobs')

/** File name for a job id (`hiring.cafe:abc` → `hiring.cafe-abc.json`), safe for any id. */
export function jobFileName(id: string): string {
  return `${id
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 180)}.json`
}

async function writeAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export async function readJob(workspace: string, id: string): Promise<Job | null> {
  try {
    const job = JSON.parse(await readFile(join(jobsDir(workspace), jobFileName(id)), 'utf8')) as Job
    return job.id === id ? job : null
  } catch {
    return null
  }
}

/**
 * Merges a fresh copy of a job into the saved one: board data is refreshed,
 * but the user's state (tailored, dismissed) and a full description fetched
 * earlier are kept.
 */
export function mergeJob(saved: Job | null, fresh: Job): Job {
  if (!saved) return fresh
  const keepDescription = saved.descriptionComplete && !fresh.descriptionComplete
  return {
    ...saved,
    ...fresh,
    description: keepDescription ? saved.description : fresh.description || saved.description,
    descriptionComplete: keepDescription || fresh.descriptionComplete,
    tailoredAt: saved.tailoredAt,
    dismissed: saved.dismissed
  }
}

export async function saveJob(workspace: string, job: Job): Promise<Job> {
  await mkdir(jobsDir(workspace), { recursive: true })
  const merged = mergeJob(await readJob(workspace, job.id), job)
  await writeAtomic(join(jobsDir(workspace), jobFileName(job.id)), merged)
  return merged
}

/** Writes a job as is (no merge), for changes the user makes. */
export async function writeJobFile(workspace: string, job: Job): Promise<Job> {
  await mkdir(jobsDir(workspace), { recursive: true })
  await writeAtomic(join(jobsDir(workspace), jobFileName(job.id)), job)
  return job
}

export async function saveJobs(workspace: string, jobs: readonly Job[]): Promise<Job[]> {
  const out: Job[] = []
  const seen = new Set<string>()
  for (const j of jobs) {
    if (seen.has(j.id)) continue
    seen.add(j.id)
    out.push(await saveJob(workspace, j))
  }
  return out
}

/** Every saved job, newest posting first; unreadable files are skipped. */
export async function listJobs(workspace: string): Promise<Job[]> {
  let names: string[]
  try {
    names = await readdir(jobsDir(workspace))
  } catch {
    return []
  }
  const jobs = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        try {
          return JSON.parse(await readFile(join(jobsDir(workspace), n), 'utf8')) as Job
        } catch {
          return null
        }
      })
  )
  return jobs
    .filter((j): j is Job => j !== null && typeof j.id === 'string')
    .sort((a, b) => (b.postedAt ?? b.fetchedAt).localeCompare(a.postedAt ?? a.fetchedAt))
}

/**
 * The same job often appears on several boards. Keeps one per
 * (normalized title, company), preferring the one with the fuller description.
 */
export function dedupeAcrossBoards(jobs: readonly Job[]): Job[] {
  const key = (j: Job) =>
    `${j.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()}|${j.company
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()}`
  const best = new Map<string, Job>()
  for (const j of jobs) {
    if (!j.company) {
      best.set(`${j.id}`, j)
      continue
    }
    const k = key(j)
    const cur = best.get(k)
    if (
      !cur ||
      (j.descriptionComplete && !cur.descriptionComplete) ||
      (j.description.length > cur.description.length && j.descriptionComplete === cur.descriptionComplete)
    )
      best.set(k, j)
  }
  return [...best.values()]
}

const MAX_SEARCHES = 10

export async function recordSearch(workspace: string, query: JobQuery, now = new Date()): Promise<void> {
  const path = join(workspace, HUNTGRY_DIR, 'searches.json')
  const list = await recentSearches(workspace)
  const same = (a: JobQuery) => JSON.stringify(a) === JSON.stringify(query)
  await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
  await writeAtomic(
    path,
    [{ query, at: now.toISOString() }, ...list.filter((s) => !same(s.query))].slice(0, MAX_SEARCHES)
  )
}

export async function recentSearches(workspace: string): Promise<SavedSearch[]> {
  try {
    const v = JSON.parse(await readFile(join(workspace, HUNTGRY_DIR, 'searches.json'), 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
