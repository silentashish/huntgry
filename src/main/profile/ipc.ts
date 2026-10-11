import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import type { MasterProfile, ResumeImportResult, SaveProfileResult } from '@shared/master-profile'
import { IPC_CHANNELS } from '@shared/workspace-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { RESUME_EXTENSIONS } from '../resume/extract'
import { droppedResumePath, importResumeFrom } from './resume-import'
import { readProfile, saveProfile } from './store'

/** The master profile file of the current workspace. The renderer never supplies this path. */
export async function currentProfilePath(): Promise<string> {
  const workspace = await requireCurrentWorkspace()
  return join(workspace.path, workspace.masterProfile)
}

/** Loose shape check: the renderer is ours, but IPC input is still untrusted. */
function requireProfile(input: unknown): MasterProfile {
  const p = input as MasterProfile
  const ok =
    typeof p === 'object' &&
    p !== null &&
    typeof p.contact === 'object' &&
    typeof p.summary === 'string' &&
    ['skills', 'experience', 'projects', 'education', 'certifications', 'publications', 'gaps', 'extraSections'].every(
      (k) => Array.isArray((p as unknown as Record<string, unknown>)[k])
    )
  if (!ok) throw new Error('Invalid master profile.')
  return p
}

/** Master profile read/save, resume import, open in editor / Finder. */
export function registerProfileIpc(): void {
  ipcMain.handle(IPC_CHANNELS.profileRead, async () => readProfile(await currentProfilePath()))

  ipcMain.handle(
    IPC_CHANNELS.profileSave,
    async (_event, profile: unknown, version: unknown): Promise<SaveProfileResult> => {
      if (typeof version !== 'string') throw new Error('Expected a profile version.')
      return saveProfile(await currentProfilePath(), requireProfile(profile), version)
    }
  )

  ipcMain.handle(IPC_CHANNELS.profileImportResume, async (event): Promise<ResumeImportResult> => {
    const options: OpenDialogOptions = {
      title: 'Choose your resume',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [{ name: 'Resume', extensions: [...RESUME_EXTENSIONS] }]
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, cancelled: true }
    return importResumeFrom(res.filePaths[0])
  })

  // A resume dropped on the window (profile setup): same parse, no dialog.
  ipcMain.handle(IPC_CHANNELS.profileImportResumeFile, async (_event, path: unknown): Promise<ResumeImportResult> => {
    const checked = droppedResumePath(path)
    return checked.ok ? importResumeFrom(checked.path) : { ok: false, cancelled: false, error: checked.error }
  })

  ipcMain.handle(IPC_CHANNELS.profileOpenInEditor, async () => {
    const error = await shell.openPath(await currentProfilePath())
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC_CHANNELS.profileReveal, async () => {
    shell.showItemInFolder(await currentProfilePath())
  })
}
