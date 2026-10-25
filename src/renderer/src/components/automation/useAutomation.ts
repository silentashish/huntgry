import { useCallback, useEffect, useState } from 'react'
import { AUTOMATION_LOG_LIMIT, type AutomationLogEntry, type AutomationSettings, type AutomationState } from '@shared/automation-types'
import { api } from '../../api'

/**
 * Automation's state (#154), kept current by `automation:changed`: subscribed first, then fetched, so a change
 * between the two is never lost. `null` until loaded (or when the API is missing, as in some tests).
 */
export function useAutomationState(): AutomationState | null {
  const [state, setState] = useState<AutomationState | null>(null)
  useEffect(() => {
    let live = true
    const off = api.on('automation:changed', (s) => setState(s))
    api.automation?.state().then(
      (s) => live && setState((cur) => cur ?? s),
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

/** The settings, saved through `updateSettings` (which returns the clamped result). */
export function useAutomationSettings(): {
  settings: AutomationSettings | null
  save(patch: Parameters<typeof api.automation.updateSettings>[0]): Promise<AutomationSettings>
} {
  const [settings, setSettings] = useState<AutomationSettings | null>(null)
  useEffect(() => {
    let live = true
    api.automation?.settings().then(
      (s) => live && setSettings(s),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  const save = useCallback(async (patch: Parameters<typeof api.automation.updateSettings>[0]) => {
    const next = await api.automation.updateSettings(patch)
    setSettings(next)
    return next
  }, [])
  return { settings, save }
}

/** The step log, newest first (at most `AUTOMATION_LOG_LIMIT`), read again on every `automation:step`. */
export function useAutomationLog(key?: string): AutomationLogEntry[] {
  const [log, setLog] = useState<AutomationLogEntry[]>([])
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      api.automation
        ?.log({ limit: AUTOMATION_LOG_LIMIT, ...(key ? { key } : {}) })
        .then(
          (entries) => live && setLog(entries),
          () => undefined
        )
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 200)
    }
    const off = api.on('automation:step', soon)
    void load()
    return () => {
      live = false
      clearTimeout(timer)
      off()
    }
  }, [key])
  return log
}
