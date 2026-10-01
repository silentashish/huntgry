import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, opendir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { DEFAULT_AGENT, isAgentId, type RunSummary } from '@shared/runner-types'
import { parseEventLine } from '@shared/transcript'
import { APPLICATION_DEPTH, HUNTGRY_DIR, IGNORED_ENTRIES, MAX_SCAN_ENTRIES } from '../workspace/constants'

/**
 * Runs on disk, inside the workspace so they travel with it:
 * `<workspace>/.huntgry/runs/<run-id>/run.json` (summary) and `events.jsonl`
 * (every stream-json line, append-only). No database.
 */

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/

/** Checks a run id from the renderer or a phone; the same shape `newRunId` produces. */
export function requireRunId(id: unknown): string {
  if (typeof id !== 'string' || !RUN_ID_PATTERN.test(id)) throw new Error('Invalid run id.')
  return id
}

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
  // Runs recorded before agents could be chosen were Claude runs.
  return { ...run, agent: isAgentId(run.agent) ? run.agent : DEFAULT_AGENT, live: false }
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

/**
 * Median wall time (ms) of the newest `sample` finished runs matching `filter`, or `null`
 * when there are none. The pipeline's duration estimate.
 */
export async function medianRunDuration(
  workspace: string,
  filter: { unattended?: boolean } = {},
  sample = 20
): Promise<number | null> {
  const runs = (await listRuns(workspace))
    .filter((r) => r.status === 'finished' && (filter.unattended === undefined || !!r.unattended === filter.unattended))
    .slice(0, sample)
    .map((r) => Date.parse(r.updatedAt) - Date.parse(r.createdAt))
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b)
  if (runs.length === 0) return null
  const mid = Math.floor(runs.length / 2)
  return runs.length % 2 ? runs[mid] : Math.round((runs[mid - 1] + runs[mid]) / 2)
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
  'resume.tex',
  'review-notes.md'
] as const

/** Lowercase dash slug, as the skill names `<role>/<company>/<job-id>` folders. */
export function folderSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface OutputFolderHints {
  /** Role, company and job id of the run; a folder whose segments match them wins over a newer one. */
  prefer?: { role?: string; company?: string; jobId?: string }
  /** Folders (relative to the workspace) that belong to other live runs. */
  exclude?: string[]
  /**
   * Job ids of other live runs. A folder whose job-id segment is one of them belongs to that
   * run even before it has recorded the folder, so it is never picked.
   */
  claimedJobIds?: string[]
}

/**
 * How well a `<role>/<company>/<job-id>` folder matches the run. The job id must be the same
 * slug (`42` is not `142`) and counts most; company and role (Claude may shorten them, so
 * containment is enough) only break ties.
 */
function matchScore(rel: string[], prefer: OutputFolderHints['prefer']): number {
  if (!prefer) return 0
  const [role, company, jobId] = rel.map(folderSlug)
  const like = (seg: string | undefined, want: string | undefined) => {
    const w = want ? folderSlug(want) : ''
    return !!seg && !!w && (seg === w || seg.includes(w) || w.includes(seg))
  }
  const sameId = !!prefer.jobId && !!jobId && jobId === folderSlug(prefer.jobId)
  return (sameId ? 4 : 0) + (like(company, prefer.company) ? 2 : 0) + (like(role, prefer.role) ? 1 : 0)
}

/**
 * The application folder (`<role>/<company>/<job-id>`) a run wrote at or after
 * `sinceMs`, relative to the workspace: among folders holding a build output,
 * the one matching the run's role/company/job id best, newest first on a tie,
 * skipping folders other live runs own or whose job id is another live run's
 * (several runs can build at once).
 * Bounded like the workspace scan; `null` when nothing qualifies.
 */
export async function findOutputFolder(
  workspace: string,
  sinceMs: number,
  hints: OutputFolderHints = {}
): Promise<{ folder: string; files: string[] } | null> {
  const exclude = new Set((hints.exclude ?? []).map((f) => join(workspace, f)))
  const own = hints.prefer?.jobId ? folderSlug(hints.prefer.jobId) : ''
  const claimed = new Set((hints.claimedJobIds ?? []).map(folderSlug).filter((id) => id && id !== own))
  let visited = 0
  let best: { path: string; mtime: number; score: number; files: string[] } | null = null

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
      if (exclude.has(dir) || claimed.has(folderSlug(relative(workspace, dir).split(sep)[2] ?? ''))) return
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
      if (mtime < sinceMs) return
      const score = matchScore(relative(workspace, dir).split(sep), hints.prefer)
      if (!best || score > best.score || (score === best.score && mtime > best.mtime))
        best = { path: dir, mtime, score, files: outputs.sort() }
      return
    }
    for (const sub of subdirs) await walk(sub, depth + 1)
  }

  await walk(workspace, 0)
  const found = best as { path: string; files: string[] } | null
  return found ? { folder: relative(workspace, found.path), files: found.files } : null
}
