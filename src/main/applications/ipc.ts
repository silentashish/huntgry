import { ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { APPLICATIONS_CHANNELS, type ApplicationTracking } from '@shared/applications-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { applicationFolder, isServableFile, readApplication, scanApplications } from './scan'
import { updateTracking } from './tracking'
import { WorkspaceWatcher } from './watch'

const watcher = new WorkspaceWatcher(() => emit('applications:changed', null))

function requireId(id: unknown): string {
  if (typeof id !== 'string' || id.length > 600) throw new Error('Invalid application id.')
  return id
}

async function folderOf(id: unknown): Promise<{ workspace: string; folder: string }> {
  const workspace = (await requireCurrentWorkspace()).path
  return { workspace, folder: applicationFolder(workspace, requireId(id)) }
}

function requirePatch(input: unknown): Partial<ApplicationTracking> {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid tracking update.')
  const allowed = ['status', 'appliedAt', 'notes', 'jobUrl', 'source']
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.includes(k)) continue
    if (typeof v !== 'string') throw new Error(`Invalid ${k}.`)
    patch[k] = v
  }
  return patch as Partial<ApplicationTracking>
}

/** Stops watching the workspace (app quit). */
export function stopApplicationsWatcher(): void {
  watcher.close()
}

/** Generated applications of the current workspace: list, tracking, files. */
export function registerApplicationsIpc(): void {
  ipcMain.handle(APPLICATIONS_CHANNELS.list, async () => {
    const workspace = (await requireCurrentWorkspace()).path
    watcher.watch(workspace)
    return scanApplications(workspace)
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.updateTracking, async (_e, id: unknown, patch: unknown) => {
    const { workspace, folder } = await folderOf(id)
    await updateTracking(folder, requirePatch(patch))
    return readApplication(workspace, folder)
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.readJobDescription, async (_e, id: unknown) => {
    const { folder } = await folderOf(id)
    try {
      return await readFile(join(folder, 'job-description.md'), 'utf8')
    } catch {
      throw new Error('This application has no job-description.md.')
    }
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.openFile, async (_e, id: unknown, file: unknown) => {
    if (typeof file !== 'string' || !isServableFile(file)) throw new Error('Unknown file.')
    const { folder } = await folderOf(id)
    const error = await shell.openPath(join(folder, file))
    if (error) throw new Error(error)
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.reveal, async (_e, id: unknown) => {
    const { folder } = await folderOf(id)
    shell.openPath(folder).catch(() => shell.showItemInFolder(folder))
  })
}
