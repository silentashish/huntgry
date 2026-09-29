import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import {
  IPC_CHANNELS,
  USABLE_STATUSES,
  type CreateResult,
  type PickMode,
  type WorkspaceInspection
} from '@shared/workspace-types'
import {
  createWorkspace,
  inspectWorkspace,
  loadSettings,
  normalizeInputPath,
  openWorkspace,
  saveSettings
} from './workspace'

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

/**
 * Non-strings are rejected outright. Strings that are not usable absolute
 * paths are passed through unchanged so the workspace module reports them as
 * `invalid` with a reason, instead of the handler throwing.
 */
function requirePath(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Expected a folder path string.')
  return normalizeInputPath(input) ?? input
}

/** Saves a usable workspace as current; other statuses leave the setting unchanged. */
async function remember(inspection: WorkspaceInspection): Promise<void> {
  if (USABLE_STATUSES.includes(inspection.status)) {
    await saveSettings(settingsFile(), { currentWorkspace: inspection.path })
  }
}

/** The only bridge between the renderer and the filesystem. */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.pickDirectory, async (event, mode: unknown) => {
    if (mode !== 'create' && mode !== 'import') throw new Error('Invalid picker mode.')
    const properties: OpenDialogOptions['properties'] =
      (mode as PickMode) === 'create'
        ? ['openDirectory', 'createDirectory', 'promptToCreate']
        : ['openDirectory']
    const options: OpenDialogOptions = {
      title: mode === 'create' ? 'Choose a folder for the new workspace' : 'Choose an existing workspace',
      buttonLabel: mode === 'create' ? 'Use Folder' : 'Import',
      properties
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.inspect, (_event, path: unknown) => inspectWorkspace(requirePath(path)))

  ipcMain.handle(IPC_CHANNELS.create, async (_event, path: unknown): Promise<CreateResult> => {
    const result = await createWorkspace(requirePath(path))
    if (result.ok) await remember(result.inspection)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.open, async (_event, path: unknown) => {
    const inspection = await openWorkspace(requirePath(path))
    await remember(inspection)
    return inspection
  })

  ipcMain.handle(IPC_CHANNELS.getCurrent, async () => {
    const { currentWorkspace } = await loadSettings(settingsFile())
    const path = normalizeInputPath(currentWorkspace)
    return path ? inspectWorkspace(path) : null
  })
}
