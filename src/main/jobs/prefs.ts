import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizePrefs, type JobsPrefs, type JobsPrefsPatch } from '@shared/jobs-prefs'
import { HUNTGRY_DIR } from '../workspace/constants'

/** `<workspace>/.huntgry/jobs-prefs.json`: the Jobs page's filters. */

export const prefsPath = (workspace: string) => join(workspace, HUNTGRY_DIR, 'jobs-prefs.json')

/** One read-modify-write at a time per workspace, so two quick filter changes cannot undo each other. */
const pending = new Map<string, Promise<unknown>>()

async function load(workspace: string): Promise<JobsPrefs> {
  try {
    return normalizePrefs(JSON.parse(await readFile(prefsPath(workspace), 'utf8')))
  } catch {
    return normalizePrefs({})
  }
}

/** The saved preferences, after any change still being written (leaving the page right after a change reads it back). */
export async function readPrefs(workspace: string): Promise<JobsPrefs> {
  await pending.get(workspace)?.catch(() => undefined)
  return load(workspace)
}

async function change(workspace: string, edit: (p: JobsPrefs) => JobsPrefs): Promise<JobsPrefs> {
  const run = (pending.get(workspace) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const next = edit(await load(workspace))
    await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
    const path = prefsPath(workspace)
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
    return next
  })
  pending.set(workspace, run)
  try {
    return await run
  } finally {
    if (pending.get(workspace) === run) pending.delete(workspace)
  }
}

/** Applies a validated patch from the renderer (`normalizePrefsPatch`). */
export function updatePrefs(workspace: string, patch: JobsPrefsPatch): Promise<JobsPrefs> {
  return change(workspace, (p) => ({ ...p, ...patch }))
}
