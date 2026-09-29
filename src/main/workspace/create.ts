import { mkdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CreateResult } from '@shared/workspace-types'
import { CLAUDE_FILE, COVER_LETTER_FILE, MASTER_PROFILE_FILE } from './constants'
import { errno, inspectWorkspace } from './inspect'
import masterProfileTemplate from './templates/master-profile.md?raw'
import coverLetterTemplate from './templates/cover-letter.md?raw'
import claudeTemplate from './templates/CLAUDE.md?raw'

/**
 * Initialise a new workspace at `inputPath`. Only `missing` and `empty`
 * targets are touched; files are written with `wx` so nothing pre-existing
 * is ever overwritten. Existing workspaces and foreign directories are refused.
 * On failure, everything this call created is removed again.
 */
export async function createWorkspace(inputPath: string): Promise<CreateResult> {
  const before = await inspectWorkspace(inputPath)

  switch (before.status) {
    case 'valid':
    case 'legacy':
      return {
        ok: false,
        inspection: before,
        created: [],
        error: 'This folder is already a Resume Tailor workspace. Use Import Existing Workspace instead.'
      }
    case 'not-a-workspace':
    case 'unverified':
    case 'invalid':
      return {
        ok: false,
        inspection: before,
        created: [],
        error: before.errors[0] ?? 'This folder cannot be used for a new workspace.'
      }
    case 'missing':
    case 'empty':
      break
  }

  const root = before.path
  if (hasControlChars(root)) {
    // The path is written into CLAUDE.md; a newline there could inject instructions.
    return {
      ok: false,
      inspection: before,
      created: [],
      error: 'The folder path contains control characters (such as a line break). Pick another folder.'
    }
  }

  const created: string[] = []
  try {
    if (before.status === 'missing') {
      // Not recursive: `missing` guarantees the parent exists, and EEXIST here means
      // something appeared at the path after inspection, so we stop instead of reusing it.
      await mkdir(root)
      created.push('.')
    }
    // Re-check right before writing: if the path was swapped for a symlink since
    // inspection, the files would land in a directory that never passed the status gate.
    if ((await realpath(root)) !== root) {
      throw Object.assign(new Error('Workspace path changed during creation.'), { code: 'ECHANGED' })
    }
    for (const [name, content] of skeletonFiles(root)) {
      if (await writeIfAbsent(join(root, name), content)) created.push(name)
    }
  } catch (err) {
    await rollback(root, created)
    return {
      ok: false,
      inspection: await inspectWorkspace(root),
      created: [],
      error: `Could not create workspace (${errno(err) ?? 'unknown error'}). Anything it created was removed.`
    }
  }

  return { ok: true, inspection: await inspectWorkspace(root), created }
}

/**
 * Skeleton files in write order. The master profile goes last: it is what makes
 * a folder `valid`, so an interrupted run never looks like a finished workspace
 * that is missing its CLAUDE.md.
 */
function skeletonFiles(root: string): Array<[string, string]> {
  const values: Record<string, string> = {
    CV_HOME: root,
    CV_HOME_SHELL: shellQuote(root),
    MASTER_PROFILE: MASTER_PROFILE_FILE,
    COVER_LETTER: COVER_LETTER_FILE
  }
  // One pass, so a `{{...}}` inside the path itself is never substituted again.
  const claude = claudeTemplate.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
  return [
    [CLAUDE_FILE, claude],
    [COVER_LETTER_FILE, coverLetterTemplate],
    [MASTER_PROFILE_FILE, masterProfileTemplate]
  ]
}

/** POSIX single-quoting: the shell expands nothing inside, and `'` becomes `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** True for C0 control characters and DEL, which have no place in a path written into markdown. */
function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

/** Returns false (and leaves the file alone) if something already exists at `path`. */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if (errno(err) === 'EEXIST') return false
    throw err
  }
}

/** Best-effort removal of what this call created (files first, then the root it made). */
async function rollback(root: string, created: string[]): Promise<void> {
  for (const name of created.filter((c) => c !== '.').reverse()) {
    await unlink(join(root, name)).catch(() => {})
  }
  if (created.includes('.')) await rmdir(root).catch(() => {})
}
