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

/** Every saved job, cross-board duplicates merged (`canonicalize`), newest posting first. */
export async function listJobs(workspace: string): Promise<Job[]> {
  return canonicalize(await listRaw(workspace)).sort((a, b) =>
    (b.postedAt ?? b.fetchedAt).localeCompare(a.postedAt ?? a.fetchedAt)
  )
}

/**
 * Normalized (title, company, city) of a job, or `null` when there is no
 * company to match on. The city is the first part of the location, so
 * "Herndon, VA" and "Herndon, Virginia, United States" agree, while the same
 * title in two cities stays two jobs.
 */
export function canonicalKey(job: Pick<Job, 'title' | 'company' | 'location' | 'remote'>): string | null {
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh)\b\.?/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  const company = norm(job.company)
  const city = job.remote && !job.location.trim() ? 'remote' : norm(job.location.split(',')[0] ?? '')
  return company ? `${norm(job.title)}|${company}|${city}` : null
}

/**
 * The same job often appears on several boards under different ids. Jobs with
 * the same (title, company, city) from **different** boards are merged; two
 * records from one board are always distinct postings. The merged record is
 * the one saved first (then the smallest id), so its id never changes; it
 * lists the others as `aliases`, takes the best description of the group and
 * merges user state (tailored if any copy was; dismissed follows the
 * canonical copy, since updates are written to every file of the group).
 * Deterministic: the same files always give the same result.
 */
export function canonicalize(jobs: readonly Job[]): Job[] {
  const byKey = new Map<string, Job[]>()
  const out: Job[] = []
  for (const j of jobs) {
    const k = canonicalKey(j)
    if (!k) {
      out.push(j)
      continue
    }
    const g = byKey.get(k)
    if (g) g.push(j)
    else byKey.set(k, [j])
  }
  // Within a key, form clusters with at most one job per board.
  const groups: Job[][] = []
  for (const g of byKey.values()) {
    const clusters: Job[][] = []
    for (const j of [...g].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id))) {
      const home = clusters.find((c) => !c.some((x) => x.source === j.source))
      if (home) home.push(j)
      else clusters.push([j])
    }
    groups.push(...clusters)
  }
  for (const sorted of groups) {
    const [first, ...rest] = sorted
    if (rest.length === 0) {
      out.push(first)
      continue
    }
    const fullest =
      sorted.find((j) => j.descriptionComplete) ??
      sorted.reduce((a, b) => (b.description.length > a.description.length ? b : a))
    const tailored = sorted
      .map((j) => j.tailoredAt)
      .filter((t): t is string => !!t)
      .sort()[0]
    out.push({
      ...first,
      description: fullest.description,
      descriptionComplete: fullest.descriptionComplete,
      salary: first.salary || rest.find((j) => j.salary)?.salary || '',
      location: first.location || rest.find((j) => j.location)?.location || '',
      tags: [...new Set(sorted.flatMap((j) => j.tags))],
      tailoredAt: tailored,
      aliases: rest.map((j) => j.id)
    })
  }
  return out
}

/** Raw saved records (one per file), not canonicalized. */
async function listRaw(workspace: string): Promise<Job[]> {
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
  return jobs.filter((j): j is Job => j !== null && typeof j.id === 'string')
}

/** The canonical job containing `id` (its own id or an alias), or `null`. */
export async function findCanonical(workspace: string, id: string): Promise<Job | null> {
  return canonicalize(await listRaw(workspace)).find((j) => j.id === id || j.aliases?.includes(id)) ?? null
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
