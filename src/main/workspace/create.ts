import { mkdir, writeFile } from 'node:fs/promises'
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
  const created: string[] = []
  try {
    if (before.status === 'missing') {
      await mkdir(root, { recursive: true })
      created.push('.')
    }
    for (const [name, content] of skeletonFiles(root)) {
      if (await writeIfAbsent(join(root, name), content)) created.push(name)
    }
  } catch (err) {
    return {
      ok: false,
      inspection: await inspectWorkspace(root),
      created,
      error: `Could not create workspace (${errno(err) ?? 'unknown error'}).`
    }
  }

  return { ok: true, inspection: await inspectWorkspace(root), created }
}

function skeletonFiles(root: string): Array<[string, string]> {
  const claude = claudeTemplate
    .replaceAll('{{CV_HOME}}', root)
    .replaceAll('{{MASTER_PROFILE}}', MASTER_PROFILE_FILE)
    .replaceAll('{{COVER_LETTER}}', COVER_LETTER_FILE)
  return [
    [MASTER_PROFILE_FILE, masterProfileTemplate],
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
