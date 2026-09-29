import { lstat, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { applicationFolder, isServableFile } from './scan'

/**
 * Filesystem-level confinement for application ids coming from the renderer.
 * `applicationFolder` only checks the id's shape; these helpers also resolve
 * symlinks, so a folder or file that points outside the workspace is refused
 * before anything is read, written, opened or served.
 */

/** The application folder for `id`: a real directory (not a symlink) whose real path is inside the workspace. */
export async function resolveApplicationFolder(workspace: string, id: string): Promise<string> {
  const folder = applicationFolder(workspace, id)
  let info
  try {
    info = await lstat(folder)
  } catch {
    throw new Error('This application folder no longer exists.')
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid application folder.')
  const [realWs, realFolder] = await Promise.all([realpath(workspace), realpath(folder)])
  const rel = relative(realWs, realFolder)
  if (!rel || rel.startsWith('..') || rel.split(sep).length !== 3 || !realFolder.startsWith(realWs + sep)) {
    throw new Error('Invalid application folder.')
  }
  return folder
}

/** A known file of an application: a regular file (symlinks refused) inside the resolved folder. */
export async function resolveApplicationFile(workspace: string, id: string, file: string): Promise<string> {
  if (!isServableFile(file)) throw new Error('Unknown file.')
  const path = join(await resolveApplicationFolder(workspace, id), file)
  let info
  try {
    info = await lstat(path)
  } catch {
    throw new Error(`${file} does not exist.`)
  }
  if (!info.isFile()) throw new Error(`${file} is not a regular file.`)
  return path
}
