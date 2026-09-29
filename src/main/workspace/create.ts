import { mkdir, writeFile } from 'node:fs/promises'
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
 * so nothing that already exists is ever overwritten.
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
  const created: string[] = []
  const skipped: string[] = []
  try {
    if (before.status === 'missing') {
      await mkdir(root, { recursive: true })
      created.push('.')
    }
    for (const [name, content] of skeletonFiles(root)) {
      if (await writeIfAbsent(join(root, name), content)) created.push(name)
      else skipped.push(name)
    }
  } catch (err) {
    return {
      ok: false,
      inspection: await inspectWorkspace(root),
      created,
      skipped,
      error: `Could not create workspace (${errno(err) ?? 'unknown error'}).`
    }
  }

  const after = await inspectWorkspace(root)
  if (!after.masterProfile) {
    // e.g. a directory or dangling link already sits at master-profile.md.
    return {
      ok: false,
      inspection: after,
      created,
      skipped,
      error: `Could not create ${MASTER_PROFILE_FILE}: something else already uses that name.`
    }
  }
  return { ok: true, inspection: after, created, skipped }
}

function skeletonFiles(root: string): Array<[string, string]> {
  const claude = claudeTemplate
    .replaceAll('{{CV_HOME}}', root)
    .replaceAll('{{MASTER_PROFILE}}', MASTER_PROFILE_FILE)
    .replaceAll('{{COVER_LETTER}}', COVER_LETTER_FILE)
  return [
    [MASTER_PROFILE_FILE, serializeMasterProfile(emptyProfile())],
    [COVER_LETTER_FILE, coverLetterTemplate],
    [CLAUDE_FILE, claude]
  ]
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
