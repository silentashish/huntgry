import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { MasterProfile, ProfileDocument, SaveProfileResult } from '@shared/master-profile'
import { errno } from '../workspace/inspect'
import { parseMasterProfile, serializeMasterProfile } from './format'

/** A master profile is a hand-written text file; anything this big is not one. */
const MAX_PROFILE_BYTES = 5 * 1024 * 1024

export async function readProfile(path: string): Promise<ProfileDocument> {
  const content = await readText(path)
  const { profile, warnings } = parseMasterProfile(content)
  return { path, profile, version: versionOf(content), warnings }
}

/**
 * Serializes `profile` over the file at `path`, but only if the file still
 * holds the content identified by `expectedVersion`; otherwise the user edited
 * it on disk meanwhile and the save is refused as a conflict.
 * The write is atomic (temp file + rename in the same directory). A symlinked
 * profile is written through to its target, so the link survives.
 */
export async function saveProfile(
  path: string,
  profile: MasterProfile,
  expectedVersion: string
): Promise<SaveProfileResult> {
  let target: string
  try {
    target = await realpath(path)
    const current = await readText(target)
    if (versionOf(current) !== expectedVersion) {
      return {
        ok: false,
        conflict: true,
        error: `${basename(path)} was changed outside Huntgry. Reload it before saving.`
      }
    }
  } catch (err) {
    return { ok: false, conflict: false, error: `Could not read ${basename(path)} (${errno(err) ?? 'unknown error'}).` }
  }

  const content = serializeMasterProfile(profile)
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    const { mode } = await stat(target)
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode })
    await rename(temp, target)
  } catch (err) {
    await rm(temp, { force: true })
    return { ok: false, conflict: false, error: `Could not save ${basename(path)} (${errno(err) ?? 'unknown error'}).` }
  }
  return { ok: true, document: await readProfile(path) }
}

async function readText(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' })
  if (info.size > MAX_PROFILE_BYTES) throw Object.assign(new Error('too large'), { code: 'EFBIG' })
  return readFile(path, 'utf8')
}

function versionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
