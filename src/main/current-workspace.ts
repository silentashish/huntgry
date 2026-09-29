import { app } from 'electron'
import { join } from 'node:path'
import { canImport, type WorkspaceInspection } from '@shared/workspace-types'
import { inspectWorkspace, loadSettings, normalizeInputPath, saveSettings } from './workspace'

/**
 * The workspace the app has open, shared by every feature's IPC handlers.
 * Features resolve paths from here; the renderer never sends workspace paths.
 */

export const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

/** Saves a usable workspace as current; other statuses leave the setting unchanged. */
export async function rememberWorkspace(inspection: WorkspaceInspection): Promise<void> {
  if (canImport(inspection)) {
    await saveSettings(settingsFile(), { currentWorkspace: inspection.path })
  }
}

/** Re-inspects the remembered workspace, or `null` when none has been chosen yet. */
export async function currentInspection(): Promise<WorkspaceInspection | null> {
  const { currentWorkspace } = await loadSettings(settingsFile())
  const path = normalizeInputPath(currentWorkspace)
  return path ? inspectWorkspace(path) : null
}

/** The open workspace with a master profile, or an error the renderer can show as is. */
export async function requireCurrentWorkspace(): Promise<WorkspaceInspection & { masterProfile: string }> {
  const inspection = await currentInspection()
  if (!inspection || !canImport(inspection) || !inspection.masterProfile) {
    throw new Error('No workspace with a master profile is open. Create or import one first.')
  }
  return inspection as WorkspaceInspection & { masterProfile: string }
}
