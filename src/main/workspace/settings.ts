import { readFile, writeFile } from 'node:fs/promises'

/**
 * App-level settings (which workspace is current), stored in a JSON file
 * outside any workspace — the caller passes `userData/settings.json`.
 * Kept free of Electron imports so it stays unit-testable.
 *
 * Note: under a future macOS App Sandbox / MAS build, persisting access to a
 * user-picked folder would need security-scoped bookmarks
 * (`securityScopedBookmarks` in `dialog.showOpenDialog`). Not needed today.
 */
export interface AppSettings {
  currentWorkspace?: string
}

export async function loadSettings(file: string): Promise<AppSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as AppSettings) : {}
  } catch {
    return {}
  }
}

export async function saveSettings(file: string, patch: AppSettings): Promise<void> {
  const next = { ...(await loadSettings(file)), ...patch }
  await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
}
