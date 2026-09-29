import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { IPC_CHANNELS, type CreateResult, type PickMode } from '@shared/workspace-types'
import { currentInspection, rememberWorkspace } from '../current-workspace'
import { createWorkspace, inspectWorkspace, normalizeInputPath, openWorkspace } from '.'

/**
 * Non-strings are rejected outright. Strings that are not usable absolute
 * paths are passed through unchanged so the workspace module reports them as
 * `invalid` with a reason, instead of the handler throwing.
 */
function requirePath(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Expected a folder path string.')
  return normalizeInputPath(input) ?? input
}

/** Workspace picker, inspection, Create and Import. */
export function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC_CHANNELS.pickDirectory, async (event, mode: unknown) => {
    if (mode !== 'create' && mode !== 'import') throw new Error('Invalid picker mode.')
    const properties: OpenDialogOptions['properties'] =
      (mode as PickMode) === 'create'
        ? ['openDirectory', 'createDirectory', 'promptToCreate']
        : ['openDirectory']
    const options: OpenDialogOptions = {
      title: mode === 'create' ? 'Choose a folder for the new workspace' : 'Choose an existing workspace',
      message:
        mode === 'create'
          ? 'Huntgry creates master-profile.md in this folder.'
          : 'Pick the folder that holds master-profile.md.',
      buttonLabel: mode === 'create' ? 'Create Here' : 'Import',
      properties
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.inspect, (_event, path: unknown) => inspectWorkspace(requirePath(path)))

  ipcMain.handle(IPC_CHANNELS.create, async (_event, path: unknown, options: unknown): Promise<CreateResult> => {
    const allowNonEmpty =
      typeof options === 'object' && options !== null && (options as { allowNonEmpty?: unknown }).allowNonEmpty === true
    const result = await createWorkspace(requirePath(path), { allowNonEmpty })
    if (result.ok) await rememberWorkspace(result.inspection)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.open, async (_event, path: unknown) => {
    const inspection = await openWorkspace(requirePath(path))
    await rememberWorkspace(inspection)
    return inspection
  })

  ipcMain.handle(IPC_CHANNELS.getCurrent, () => currentInspection())
}
