import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, opendir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { RunSummary } from '@shared/runner-types'
import { parseEventLine } from '@shared/transcript'
import { APPLICATION_DEPTH, HUNTGRY_DIR, IGNORED_ENTRIES, MAX_SCAN_ENTRIES } from '../workspace/constants'

/**
 * Runs on disk, inside the workspace so they travel with it:
 * `<workspace>/.huntgry/runs/<run-id>/run.json` (summary) and `events.jsonl`
 * (every stream-json line, append-only). No database.
 */

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/

export function runsDir(workspace: string): string {
  return join(workspace, HUNTGRY_DIR, 'runs')
}

export function runDir(workspace: string, id: string): string {
  if (!RUN_ID_PATTERN.test(id)) throw new Error('Invalid run id.')
  return join(runsDir(workspace), id)
}

/** Sortable, filesystem-safe id: `20260929-013000-a1b2c3`. */
export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${d}-${t}-${randomBytes(3).toString('hex')}`
}

/** Writes `run.json` atomically (temp file + rename in the same folder). */
export async function saveRun(workspace: string, run: RunSummary): Promise<void> {
  const dir = runDir(workspace, run.id)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.run.json.${randomBytes(4).toString('hex')}.tmp`)
  // `live` is runtime state; a run read back from disk is never live.
  await writeFile(tmp, `${JSON.stringify({ ...run, live: false }, null, 2)}\n`, 'utf8')
  await rename(tmp, join(dir, 'run.json'))
}

export async function appendEvent(workspace: string, id: string, event: unknown): Promise<void> {
  await appendFile(join(runDir(workspace, id), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
}

export async function readRun(workspace: string, id: string): Promise<RunSummary> {
  const run = JSON.parse(await readFile(join(runDir(workspace, id), 'run.json'), 'utf8')) as RunSummary
  // A run that was active when the app quit is no longer running.
  if (run.status === 'running') run.status = 'stopped'
  return { ...run, live: false }
}

export async function readEvents(workspace: string, id: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(join(runDir(workspace, id), 'events.jsonl'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return text
    .split('\n')
    .map(parseEventLine)
    .filter((e): e is Record<string, unknown> => e !== null)
}

/** Every run with a readable `run.json`, newest first. Broken folders are skipped. */
export async function listRuns(workspace: string): Promise<RunSummary[]> {
  let names: string[]
  try {
    names = await readdir(runsDir(workspace))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const runs = await Promise.all(
    names.filter((n) => RUN_ID_PATTERN.test(n)).map((n) => readRun(workspace, n).catch(() => null))
  )
  return runs
    .filter((r): r is RunSummary => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

/** Files a run's application folder can hold that are worth opening from the app. */
export const OUTPUT_FILES = [
  'resume.pdf',
  'cover.pdf',
  'resume.docx',
  'job-description.md',
  'build-report.json',
  'resume_data.json',
  'cover_data.json',
  'resume.tex'
] as const

/**
 * The application folder (`<role>/<company>/<job-id>`) changed most recently
 * at or after `sinceMs` that holds a build output, relative to the workspace.
 * Bounded like the workspace scan; `null` when nothing qualifies.
 */
export async function findOutputFolder(
  workspace: string,
  sinceMs: number
): Promise<{ folder: string; files: string[] } | null> {
  let visited = 0
  let best: { path: string; mtime: number; files: string[] } | null = null

  async function walk(dir: string, depth: number): Promise<void> {
    if (visited > MAX_SCAN_ENTRIES) return
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      return
    }
    const subdirs: string[] = []
    const files: string[] = []
    for await (const e of handle) {
      if (++visited > MAX_SCAN_ENTRIES) break
      if (IGNORED_ENTRIES.has(e.name) || e.name.startsWith('.')) continue
      if (e.isDirectory()) subdirs.push(join(dir, e.name))
      else if (e.isFile()) files.push(e.name)
    }
    if (depth === APPLICATION_DEPTH) {
      const outputs = files.filter((f) => (OUTPUT_FILES as readonly string[]).includes(f))
      if (
        !outputs.includes('resume.pdf') &&
        !outputs.includes('build-report.json') &&
        !outputs.includes('resume_data.json')
      )
        return
      const mtimes = await Promise.all(
        outputs.map((f) =>
          stat(join(dir, f)).then(
            (s) => s.mtimeMs,
            () => 0
          )
        )
      )
      const mtime = Math.max(...mtimes)
      if (mtime >= sinceMs && (!best || mtime > best.mtime)) best = { path: dir, mtime, files: outputs.sort() }
      return
    }
    for (const sub of subdirs) await walk(sub, depth + 1)
  }

  await walk(workspace, 0)
  const found = best as { path: string; mtime: number; files: string[] } | null
  return found ? { folder: relative(workspace, found.path), files: found.files } : null
}
