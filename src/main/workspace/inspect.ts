import { constants as fsConstants, type Dirent } from 'node:fs'
import { access, lstat, opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { WorkspaceInspection, WorkspaceStatus } from '@shared/workspace-types'
import {
  APPLICATION_DEPTH,
  APPLICATION_MARKERS,
  COVER_LETTER_FILE,
  IGNORED_ENTRIES,
  LEGACY_MASTER_PROFILE_FILE,
  MASTER_PROFILE_FILE,
  MAX_SCAN_ENTRIES
} from './constants'

/**
 * Read-only inspection of a candidate workspace directory. Never writes,
 * never follows symlinks below the root, and bounds the directory scan.
 */
export async function inspectWorkspace(
  inputPath: string,
  options: { maxEntries?: number } = {}
): Promise<WorkspaceInspection> {
  const maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES
  if (!isAbsolute(inputPath)) {
    return result(inputPath, 'invalid', { errors: ['Path must be absolute.'] })
  }
  const requested = resolve(inputPath)

  let root: string
  try {
    // A symlinked root is resolved and its target inspected; the real path is what we report.
    root = await realpath(requested)
  } catch (err) {
    if (errno(err) === 'ENOENT') {
      // realpath() also fails with ENOENT for a dangling symlink; that path exists, so it is not "missing".
      if (await lstat(requested).then((s) => s.isSymbolicLink(), () => false)) {
        return result(requested, 'invalid', {
          errors: ['Path is a symlink whose target does not exist.']
        })
      }
      return inspectMissing(requested)
    }
    return result(requested, 'invalid', { errors: [describeFsError(err, 'Cannot access path')] })
  }

  try {
    const info = await stat(root)
    if (!info.isDirectory()) {
      return result(root, 'invalid', { errors: ['Path is not a directory.'] })
    }
    await access(root, fsConstants.R_OK | fsConstants.W_OK)
  } catch (err) {
    return result(root, 'invalid', {
      errors: [describeFsError(err, 'Directory is not readable and writable')]
    })
  }

  // One budget for the whole inspection, root listing included, so a huge folder is never read in full.
  const budget: ScanBudget = { remaining: maxEntries, exhausted: false }
  let entries: EntryLike[]
  try {
    entries = await readEntriesBounded(root, budget)
  } catch (err) {
    return result(root, 'invalid', { errors: [describeFsError(err, 'Cannot list directory')] })
  }
  if (budget.exhausted) entries = entries.concat(await probeWellKnown(root, entries))

  const meaningful = entries.filter((e) => !IGNORED_ENTRIES.has(e.name))
  if (meaningful.length === 0 && !budget.exhausted) return result(root, 'empty')

  const profile = await findMasterProfile(root, meaningful)
  const masterProfile = profile.name
  const applicationCount = await countApplications(root, meaningful, budget)
  const warnings = [...profile.warnings]
  if (budget.exhausted) {
    warnings.push(`Scan stopped after ${maxEntries} entries; the application count may be incomplete.`)
  }

  if (masterProfile && sameName(masterProfile, MASTER_PROFILE_FILE)) {
    if (!meaningful.some((e) => sameName(e.name, COVER_LETTER_FILE))) {
      warnings.push(`Optional ${COVER_LETTER_FILE} not found.`)
    }
    return result(root, 'valid', {
      masterProfile,
      layout: 'v3',
      applicationCount,
      warnings
    })
  }

  if (masterProfile || applicationCount > 0) {
    if (masterProfile) {
      warnings.push(
        `Uses the older ${LEGACY_MASTER_PROFILE_FILE} name; the current skill README uses ${MASTER_PROFILE_FILE}.`
      )
    } else {
      warnings.push(
        `No master profile found. Add ${MASTER_PROFILE_FILE} at the workspace root before generating resumes.`
      )
    }
    return result(root, 'legacy', {
      masterProfile,
      layout: 'legacy',
      applicationCount,
      warnings
    })
  }

  return result(root, 'not-a-workspace', {
    warnings,
    errors: [
      'Directory is not empty and does not look like a Resume Tailor workspace (no master profile or application folders).'
    ]
  })
}

async function inspectMissing(requested: string): Promise<WorkspaceInspection> {
  let parent = dirname(requested)
  let path = requested
  try {
    // Resolve the parent too, so the path reported before and after Create is the same.
    parent = await realpath(parent)
    path = join(parent, basename(requested))
    const info = await stat(parent)
    if (!info.isDirectory()) {
      return result(path, 'invalid', { errors: [`Parent ${parent} is not a directory.`] })
    }
    await access(parent, fsConstants.W_OK)
  } catch (err) {
    const reason =
      errno(err) === 'ENOENT'
        ? `Parent directory ${parent} does not exist.`
        : describeFsError(err, `Parent directory ${parent} is not writable`)
    return result(path, 'invalid', { errors: [reason] })
  }
  return result(path, 'missing')
}

interface MasterProfileResult {
  name: string | null
  warnings: string[]
}

/**
 * Case-insensitive match (APFS/NTFS are case-insensitive by default); v3 name
 * wins over legacy. A candidate only counts if it is a readable regular file.
 * A symlink is resolved explicitly (this one well-known file, not a scan) and
 * accepted only when its target is a readable regular file; dangling links and
 * links to directories are ignored with a warning.
 */
async function findMasterProfile(root: string, entries: EntryLike[]): Promise<MasterProfileResult> {
  const warnings: string[] = []
  for (const wanted of [MASTER_PROFILE_FILE, LEGACY_MASTER_PROFILE_FILE]) {
    for (const e of entries.filter((e) => sameName(e.name, wanted))) {
      const path = join(root, e.name)
      if (!e.isFile() && !e.isSymbolicLink()) {
        warnings.push(`${e.name} is not a file; ignored.`)
        continue
      }
      try {
        const info = await stat(path)
        if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' })
        await access(path, fsConstants.R_OK)
      } catch (err) {
        const why =
          errno(err) === 'ENOENT'
            ? 'is a symlink whose target does not exist'
            : errno(err) === 'ENOTFILE'
              ? 'does not point to a regular file'
              : 'is not readable'
        warnings.push(`${e.name} ${why}; ignored.`)
        continue
      }
      if (e.isSymbolicLink()) {
        warnings.push(`${e.name} is a symlink to ${await realpath(path)}.`)
      }
      return { name: e.name, warnings }
    }
  }
  return { name: null, warnings }
}

/** The parts of a Dirent the inspection uses; lets lstat() probes stand in for listing entries. */
type EntryLike = Pick<Dirent, 'name' | 'isFile' | 'isDirectory' | 'isSymbolicLink'>

export interface ScanBudget {
  remaining: number
  /** Set once an entry had to be skipped because the budget ran out. */
  exhausted: boolean
}

/**
 * Streams a directory with opendir() and stops reading as soon as the shared
 * budget is spent, so a folder with millions of entries is never loaded whole.
 * Dirent types have lstat semantics: symlinks are reported, never followed.
 */
export async function readEntriesBounded(dir: string, budget: ScanBudget): Promise<Dirent[]> {
  const out: Dirent[] = []
  // for await closes the handle on completion and on break.
  for await (const entry of await opendir(dir, { bufferSize: 64 })) {
    if (budget.remaining <= 0) {
      budget.exhausted = true
      break
    }
    budget.remaining--
    out.push(entry)
  }
  return out
}

/** When the root listing was cut short, look up the well-known files directly. */
async function probeWellKnown(root: string, seen: EntryLike[]): Promise<EntryLike[]> {
  const found: EntryLike[] = []
  for (const name of [MASTER_PROFILE_FILE, LEGACY_MASTER_PROFILE_FILE, COVER_LETTER_FILE]) {
    if (seen.some((e) => sameName(e.name, name))) continue
    const info = await lstat(join(root, name)).catch(() => null)
    if (!info) continue
    found.push({
      name,
      isFile: () => info.isFile(),
      isDirectory: () => info.isDirectory(),
      isSymbolicLink: () => info.isSymbolicLink()
    })
  }
  return found
}

/**
 * Counts `<role>/<company>/<job-id>/` folders holding at least one build.py
 * artifact, starting from the already-read root entries. Symlinks are never
 * followed and every read draws from the same budget.
 */
async function countApplications(
  root: string,
  rootEntries: EntryLike[],
  budget: ScanBudget
): Promise<number> {
  const subdirs = (dir: string, entries: EntryLike[]): string[] =>
    entries.filter((e) => e.isDirectory() && !IGNORED_ENTRIES.has(e.name)).map((e) => join(dir, e.name))

  let frontier = subdirs(root, rootEntries)
  for (let depth = 2; depth <= APPLICATION_DEPTH; depth++) {
    const next: string[] = []
    for (const dir of frontier) {
      if (budget.exhausted) return 0
      next.push(...subdirs(dir, await readEntriesSafe(dir, budget)))
    }
    frontier = next
  }

  let count = 0
  for (const dir of frontier) {
    if (budget.exhausted) break
    const entries = await readEntriesSafe(dir, budget)
    if (entries.some((e) => e.isFile() && APPLICATION_MARKERS.has(e.name))) count++
  }
  return count
}

async function readEntriesSafe(dir: string, budget: ScanBudget): Promise<Dirent[]> {
  try {
    return await readEntriesBounded(dir, budget)
  } catch {
    return []
  }
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function result(
  path: string,
  status: WorkspaceStatus,
  extra: Partial<Omit<WorkspaceInspection, 'path' | 'status'>> = {}
): WorkspaceInspection {
  return {
    path,
    status,
    masterProfile: null,
    layout: null,
    applicationCount: 0,
    warnings: [],
    errors: [],
    ...extra
  }
}

export function errno(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined
}

function describeFsError(err: unknown, prefix: string): string {
  const code = errno(err)
  if (code === 'EACCES' || code === 'EPERM') return `${prefix}: permission denied.`
  return code ? `${prefix} (${code}).` : `${prefix}.`
}

/**
 * Import: identical to inspection by design. Import must never modify the
 * workspace; remembering it as "current" is the caller's job and lives in app settings.
 */
export const openWorkspace = inspectWorkspace
