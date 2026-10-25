import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { BenchJob, BenchSet } from './types'

/**
 * A bench set is a folder of job files, one JSON object per job (or a `jobs/` subfolder of them). Only the
 * description is required; `id` defaults to the file name. The real set holds the user's own saved jobs, so it
 * lives in their workspace (`.huntgry/bench/`) or anywhere else, never in the repository.
 *
 * ```json
 * { "id": "senior-backend", "role": "senior-backend-engineer", "company": "acme", "descriptionFile": "senior-backend.md",
 *   "url": "https://boards.greenhouse.io/acme/jobs/1", "coverLetter": true, "dateStyle": "right",
 *   "seniority": "senior", "stack": ["go", "aws"] }
 * ```
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export async function loadBenchSet(dir: string): Promise<BenchSet> {
  const root = resolve(dir)
  const jobsDir = (await isDir(join(root, 'jobs'))) ? join(root, 'jobs') : root
  const files = (await readdir(jobsDir)).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) throw new Error(`No job files (*.json) in ${jobsDir}.`)
  const hash = createHash('sha256')
  const jobs: BenchJob[] = []
  for (const file of files) {
    const raw = await readFile(join(jobsDir, file), 'utf8')
    hash.update(`${file}\n${raw}\n`)
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(`${file}: not JSON.`)
    }
    const job = await benchJob(data, basename(file, '.json'), jobsDir, file)
    if (job.descriptionFile) hash.update(`${job.descriptionFile}\n${job.job.description}\n`)
    jobs.push(job.job)
  }
  const ids = jobs.map((j) => j.id)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup) throw new Error(`Two jobs have the id "${dup}".`)
  return { dir: root, sha256: hash.digest('hex'), jobs }
}

async function benchJob(data: unknown, fallbackId: string, dir: string, file: string): Promise<{ job: BenchJob; descriptionFile?: string }> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${file}: not a JSON object.`)
  const d = data as Record<string, unknown>
  const text = (k: string) => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : undefined)
  const id = text('id') ?? fallbackId
  if (!SLUG.test(id)) throw new Error(`${file}: id "${id}" must be a lowercase slug (a-z, 0-9, -).`)
  const descriptionFile = text('descriptionFile')
  let description = text('description')
  if (!description && descriptionFile) {
    // Relative to the set folder, and never outside it.
    const path = resolve(dir, descriptionFile)
    const rel = relative(dir, path)
    if (isAbsolute(descriptionFile) || !rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file}: descriptionFile must be inside the set folder.`)
    description = (await readFile(path, 'utf8')).trim()
  }
  if (!description) throw new Error(`${file}: needs "description" or "descriptionFile".`)
  const slug = (k: string, fallback: string) => {
    const v = (text(k) ?? fallback).toLowerCase()
    if (!SLUG.test(v)) throw new Error(`${file}: ${k} "${v}" must be a lowercase slug (a-z, 0-9, -).`)
    return v
  }
  const job: BenchJob = {
    id,
    role: slug('role', 'role'),
    company: slug('company', 'company'),
    jobId: slug('jobId', id),
    description,
    coverLetter: d.coverLetter !== false,
    dateStyle: d.dateStyle === 'inline' ? 'inline' : 'right'
  }
  const url = text('url')
  if (url) job.url = url
  const seniority = text('seniority')
  if (seniority) job.seniority = seniority
  if (Array.isArray(d.stack)) job.stack = d.stack.filter((s): s is string => typeof s === 'string')
  return { job, descriptionFile }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
