import { constants as fsConstants, type Dirent } from 'node:fs'
import { access, readdir, realpath, stat } from 'node:fs/promises'
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
export async function inspectWorkspace(inputPath: string): Promise<WorkspaceInspection> {
  if (!isAbsolute(inputPath)) {
    return result(inputPath, 'invalid', { errors: ['Path must be absolute.'] })
  }
  const requested = resolve(inputPath)

  let root: string
  try {
    // A symlinked root is resolved and its target inspected; the real path is what we report.
    root = await realpath(requested)
  } catch (err) {
    if (errno(err) === 'ENOENT') return inspectMissing(requested)
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

  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (err) {
    return result(root, 'invalid', { errors: [describeFsError(err, 'Cannot list directory')] })
  }

  const meaningful = entries.filter((e) => !IGNORED_ENTRIES.has(e.name))
  if (meaningful.length === 0) return result(root, 'empty')

  const masterProfile = findMasterProfile(meaningful)
  const scan = await scanApplications(root)
  const warnings = scan.truncated
    ? [`Scan stopped after ${MAX_SCAN_ENTRIES} entries; the application count may be incomplete.`]
    : []

  if (masterProfile && sameName(masterProfile, MASTER_PROFILE_FILE)) {
    if (!meaningful.some((e) => sameName(e.name, COVER_LETTER_FILE))) {
      warnings.push(`Optional ${COVER_LETTER_FILE} not found.`)
    }
    return result(root, 'valid', {
      masterProfile,
      layout: 'v3',
      applicationCount: scan.count,
      warnings
    })
  }

  if (masterProfile || scan.count > 0) {
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
      applicationCount: scan.count,
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

/** Case-insensitive match (APFS/NTFS are case-insensitive by default). v3 name wins over legacy. */
function findMasterProfile(entries: Dirent[]): string | null {
  for (const wanted of [MASTER_PROFILE_FILE, LEGACY_MASTER_PROFILE_FILE]) {
    const hit = entries.find((e) => (e.isFile() || e.isSymbolicLink()) && sameName(e.name, wanted))
    if (hit) return hit.name
  }
  return null
}

interface ScanResult {
  count: number
  truncated: boolean
}

/**
 * Counts `<role>/<company>/<job-id>/` folders holding at least one build.py
 * artifact. Uses Dirent types (lstat semantics), so symlinks are never followed.
 */
async function scanApplications(root: string): Promise<ScanResult> {
  let visited = 0
  let count = 0
  let frontier = [root]

  for (let depth = 1; depth <= APPLICATION_DEPTH; depth++) {
    const next: string[] = []
    for (const dir of frontier) {
      const entries = await readdirSafe(dir)
      visited += entries.length
      if (visited > MAX_SCAN_ENTRIES) return { count, truncated: true }
      for (const e of entries) {
        if (e.isDirectory() && !IGNORED_ENTRIES.has(e.name)) next.push(join(dir, e.name))
      }
    }
    frontier = next
  }

  for (const dir of frontier) {
    const entries = await readdirSafe(dir)
    visited += entries.length
    if (visited > MAX_SCAN_ENTRIES) return { count, truncated: true }
    if (entries.some((e) => e.isFile() && APPLICATION_MARKERS.has(e.name))) count++
  }
  return { count, truncated: false }
}

async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
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
