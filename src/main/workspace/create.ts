import { mkdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyProfile } from '@shared/master-profile'
import type { CreateOptions, CreateResult } from '@shared/workspace-types'
import { serializeMasterProfile } from '../profile/format'
import { CLAUDE_FILE, COVER_LETTER_FILE, MASTER_PROFILE_FILE } from './constants'
import { errno, inspectWorkspace } from './inspect'
import coverLetterTemplate from './templates/cover-letter.md?raw'
import claudeTemplate from './templates/CLAUDE.md?raw'

/**
 * Initialise a new workspace at `inputPath`: an empty master profile, the
 * optional cover letter and CLAUDE.md. `missing` and `empty` folders are set
 * up directly. A folder with other content but no master profile (unrelated
 * files, or an older workspace with only application folders) is set up only
 * with `allowNonEmpty`, after the user confirmed. Files are written with `wx`,
 * so nothing that already exists is ever overwritten. On failure, everything
 * this call created is removed again.
 */
export async function createWorkspace(inputPath: string, options: CreateOptions = {}): Promise<CreateResult> {
  const before = await inspectWorkspace(inputPath)
  const refuse = (error: string, extra: Partial<CreateResult> = {}): CreateResult => ({
    ok: false,
    inspection: before,
    created: [],
    skipped: [],
    error,
    ...extra
  })

  switch (before.status) {
    case 'valid':
    case 'legacy':
      if (before.masterProfile) {
        return refuse(
          `This folder already has a master profile (${before.masterProfile}). Use Import Existing Workspace instead.`
        )
      }
      if (!options.allowNonEmpty) {
        return refuse('This folder holds application folders but no master profile. Confirm to add one.', {
          needsConfirmation: true
        })
      }
      break
    case 'not-a-workspace':
      if (!options.allowNonEmpty) {
        return refuse('This folder is not empty. Confirm to add the workspace files next to what is there.', {
          needsConfirmation: true
        })
      }
      break
    case 'unverified':
    case 'invalid':
      return refuse(before.errors[0] ?? 'This folder cannot be used for a new workspace.')
    case 'missing':
    case 'empty':
      break
  }

  const root = before.path
  if (hasControlChars(root)) {
    // The path is written into CLAUDE.md; a newline there could inject instructions.
    return refuse('The folder path contains control characters (such as a line break). Pick another folder.')
  }

  const created: string[] = []
  const skipped: string[] = []
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
      else skipped.push(name)
    }
  } catch (err) {
    await rollback(root, created)
    return {
      ok: false,
      inspection: await inspectWorkspace(root),
      created: [],
      skipped,
      error: `Could not create workspace (${errno(err) ?? 'unknown error'}). Anything it created was removed.`
    }
  }

  const after = await inspectWorkspace(root)
  if (!after.masterProfile) {
    // e.g. a directory or dangling link already sits at master-profile.md.
    await rollback(root, created)
    return {
      ok: false,
      inspection: await inspectWorkspace(root),
      created: [],
      skipped,
      error: `Could not create ${MASTER_PROFILE_FILE}: something else already uses that name.`
    }
  }
  return { ok: true, inspection: after, created, skipped }
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
    [MASTER_PROFILE_FILE, serializeMasterProfile(emptyProfile())]
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
