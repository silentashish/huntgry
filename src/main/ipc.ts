import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { basename, join } from 'node:path'
import type { MasterProfile, ResumeImportResult, SaveProfileResult } from '@shared/master-profile'
import {
  IPC_CHANNELS,
  canImport,
  type CreateResult,
  type PickMode,
  type WorkspaceInspection
} from '@shared/workspace-types'
import { readProfile, saveProfile } from './profile/store'
import { readResumeLines, RESUME_EXTENSIONS, ResumeReadError } from './resume/extract'
import { parseResume } from './resume/parse'
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

async function remember(inspection: WorkspaceInspection): Promise<void> {
  if (canImport(inspection)) {
    await saveSettings(settingsFile(), { currentWorkspace: inspection.path })
  }
}

async function currentInspection(): Promise<WorkspaceInspection | null> {
  const { currentWorkspace } = await loadSettings(settingsFile())
  const path = normalizeInputPath(currentWorkspace)
  return path ? inspectWorkspace(path) : null
}

/** The master profile file of the current workspace. The renderer never supplies this path. */
async function currentProfilePath(): Promise<string> {
  const inspection = await currentInspection()
  if (!inspection || !canImport(inspection) || !inspection.masterProfile) {
    throw new Error('No workspace with a master profile is open. Create or import one first.')
  }
  return join(inspection.path, inspection.masterProfile)
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
    if (result.ok) await remember(result.inspection)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.open, async (_event, path: unknown) => {
    const inspection = await openWorkspace(requirePath(path))
    await remember(inspection)
    return inspection
  })

  ipcMain.handle(IPC_CHANNELS.getCurrent, () => currentInspection())

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
    const file = res.filePaths[0]
    try {
      const { profile, warnings } = parseResume(await readResumeLines(file))
      return { ok: true, fileName: basename(file), profile, warnings }
    } catch (err) {
      const reason = err instanceof ResumeReadError ? err.message : 'The file could not be read as a resume.'
      console.error('Resume import failed:', err)
      return { ok: false, cancelled: false, error: `${basename(file)}: ${reason}` }
    }
  })

  ipcMain.handle(IPC_CHANNELS.profileOpenInEditor, async () => {
    const error = await shell.openPath(await currentProfilePath())
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC_CHANNELS.profileReveal, async () => {
    shell.showItemInFolder(await currentProfilePath())
  })
}
