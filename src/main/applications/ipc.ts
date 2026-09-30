import { ipcMain, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { APPLICATIONS_CHANNELS, type ApplicationTracking } from '@shared/applications-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { resolveApplicationFile, resolveApplicationFolder } from './safe-path'
import { readApplication, scanApplications } from './scan'
import { updateTracking } from './tracking'
import { WorkspaceWatcher } from './watch'

const watcher = new WorkspaceWatcher(() => emit('applications:changed', null))

function requireId(id: unknown): string {
  if (typeof id !== 'string' || id.length > 600) throw new Error('Invalid application id.')
  return id
}

async function currentWorkspace(): Promise<string> {
  return (await requireCurrentWorkspace()).path
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

  ipcMain.handle(APPLICATIONS_CHANNELS.get, async (_e, id: unknown) => {
    const workspace = await currentWorkspace()
    return readApplication(workspace, await resolveApplicationFolder(workspace, requireId(id)))
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.updateTracking, async (_e, id: unknown, patch: unknown) => {
    const workspace = await currentWorkspace()
    const folder = await resolveApplicationFolder(workspace, requireId(id))
    await updateTracking(folder, requirePatch(patch))
    return readApplication(workspace, folder)
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.readJobDescription, async (_e, id: unknown) => {
    const path = await resolveApplicationFile(await currentWorkspace(), requireId(id), 'job-description.md').catch(
      () => {
        throw new Error('This application has no job-description.md.')
      }
    )
    return readFile(path, 'utf8')
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.openFile, async (_e, id: unknown, file: unknown) => {
    if (typeof file !== 'string') throw new Error('Unknown file.')
    const error = await shell.openPath(await resolveApplicationFile(await currentWorkspace(), requireId(id), file))
    if (error) throw new Error(error)
  })

  ipcMain.handle(APPLICATIONS_CHANNELS.reveal, async (_e, id: unknown) => {
    const folder = await resolveApplicationFolder(await currentWorkspace(), requireId(id))
    // openPath resolves with an error string instead of rejecting.
    const error = await shell.openPath(folder)
    if (error) shell.showItemInFolder(folder)
  })
}
