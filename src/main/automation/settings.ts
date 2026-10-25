import {
  normalizeAutomationSettings,
  type AutomationSettings,
  type AutomationSettingsPatch
} from '@shared/automation-types'
import { loadSettings, saveSettings } from '../workspace/settings'

/**
 * Automation's settings and caps (#154), in `userData/settings.json` under `automation`: outside the
 * workspace, so an agent writing into the workspace cannot raise a cap. Read with defaults and clamped
 * (`normalizeAutomationSettings`). Electron-free, like `remote/settings.ts`.
 */

export async function readAutomationSettings(file: string): Promise<AutomationSettings> {
  return normalizeAutomationSettings((await loadSettings(file)).automation)
}

/** One write at a time: `saveSettings` reads, merges and renames, so two quick changes could undo each other. */
let pending: Promise<unknown> = Promise.resolve()

/** Merges a checked patch (`requireSettingsPatch`) into the stored settings; returns the clamped result. */
export function updateAutomationSettings(file: string, patch: AutomationSettingsPatch): Promise<AutomationSettings> {
  const run = pending
    .catch(() => undefined)
    .then(async () => {
      const current = await readAutomationSettings(file)
      const next = normalizeAutomationSettings({
        ...current,
        ...patch,
        sources: { ...current.sources, ...patch.sources }
      })
      await saveSettings(file, { automation: next })
      return next
    })
  pending = run
  return run
}
