import { COMMAND_TTL_SECONDS, TTL_SECONDS } from '@shared/remote'
import { loadSettings, saveSettings, type AppSettings } from '../workspace/settings'

/**
 * The remote-control part of `userData/settings.json` (next to `defaultAgent`), read and written
 * with defaults applied and every value checked: the session is off unless enabled,
 * notification details are off, transcripts on, and the command TTLs the gateway enforces on
 * delivery are 2 h for costly commands and 24 h for the rest (ADR-0001, "Offline behaviour").
 * Electron-free so the persistence is unit-tested.
 */

export interface RemoteSettings {
  enabled: boolean
  notificationDetails: boolean
  transcripts: boolean
  /** Seconds a command may have waited at the relay before the gateway refuses it as `expired`. */
  commandTtl: { costly: number; default: number }
}

/** A TTL is at least a minute and at most the protocol's 7 days. */
export const COMMAND_TTL_BOUNDS = { min: 60, max: TTL_SECONDS.max } as const

const validTtl = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= COMMAND_TTL_BOUNDS.min && v <= COMMAND_TTL_BOUNDS.max

/** The remote settings with defaults; a value that is missing or out of range falls back to its default. */
export function remoteSettingsOf(settings: AppSettings): RemoteSettings {
  const r = settings.remote ?? {}
  return {
    enabled: r.enabled === true,
    notificationDetails: r.notificationDetails === true,
    transcripts: r.transcripts !== false,
    commandTtl: {
      costly: validTtl(r.costlyTtlSeconds) ? r.costlyTtlSeconds : COMMAND_TTL_SECONDS.costly,
      default: validTtl(r.defaultTtlSeconds) ? r.defaultTtlSeconds : COMMAND_TTL_SECONDS.default
    }
  }
}

export async function readRemoteSettings(file: string): Promise<RemoteSettings> {
  return remoteSettingsOf(await loadSettings(file))
}

export type RemoteSettingsPatch = Partial<Pick<RemoteSettings, 'enabled' | 'notificationDetails' | 'transcripts'>> & { commandTtl?: { costly: number; default: number } }

/** Merges a checked patch into `settings.remote`, keeping every other setting; returns the result. */
export async function updateRemoteSettings(file: string, patch: RemoteSettingsPatch): Promise<RemoteSettings> {
  const current = (await loadSettings(file)).remote ?? {}
  const next: NonNullable<AppSettings['remote']> = { ...current }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.notificationDetails !== undefined) next.notificationDetails = patch.notificationDetails === true
  if (patch.transcripts !== undefined) next.transcripts = patch.transcripts !== false
  if (patch.commandTtl) {
    if (!validTtl(patch.commandTtl.costly) || !validTtl(patch.commandTtl.default)) {
      throw new Error(`Command TTLs must be whole seconds between ${COMMAND_TTL_BOUNDS.min} and ${COMMAND_TTL_BOUNDS.max}.`)
    }
    next.costlyTtlSeconds = patch.commandTtl.costly
    next.defaultTtlSeconds = patch.commandTtl.default
  }
  await saveSettings(file, { remote: next })
  return remoteSettingsOf({ remote: next })
}
