import type { RemoteCommandTtl } from '@shared/remote-types'
import { normalizeRelayUrl } from './credentials'
import { COMMAND_TTL_BOUNDS } from './settings'

/**
 * Validators for every `RemoteApi` argument the renderer sends (#37): it may send only ids,
 * booleans, whole numbers, the relay URL and the admin token typed into the form. Anything else
 * (extra keys, objects where a string belongs, a key or a path) is refused before it reaches the
 * stores. Electron-free so they are tested.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function onlyKeys(v: Record<string, unknown>, keys: readonly string[]): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Error('Invalid value.')
}

export function requireBoolean(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('Invalid value.')
  return v
}

const ID = /^[A-Za-z0-9-]{1,128}$/

/** A device or pairing id as this Mac minted it (UUIDs; ids from before #37 are UUID-like too). */
export function requireRemoteId(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${what}.`)
  return v
}

/** The relay form: an `https://` URL (with the reason otherwise) and the admin token, nothing else. */
export function requireConfigureInput(v: unknown): { relayUrl: string; adminToken: string } {
  if (!isRecord(v)) throw new Error('Invalid value.')
  onlyKeys(v, ['relayUrl', 'adminToken'])
  const relayUrl = normalizeRelayUrl(v.relayUrl)
  const token = typeof v.adminToken === 'string' ? v.adminToken.trim() : ''
  if (!token) throw new Error('Enter the relay admin token.')
  if (token.length > 512 || /\s/.test(token)) throw new Error('The admin token must be one line of at most 512 characters.')
  return { relayUrl, adminToken: token }
}

/** The two TTL fields, whole seconds within `COMMAND_TTL_BOUNDS`. */
export function requireCommandTtlInput(v: unknown): { costly: number; default: number } {
  if (!isRecord(v)) throw new Error('Invalid value.')
  onlyKeys(v, ['costlySeconds', 'defaultSeconds'] satisfies (keyof RemoteCommandTtl)[])
  const check = (x: unknown, label: string): number => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < COMMAND_TTL_BOUNDS.min || x > COMMAND_TTL_BOUNDS.max) {
      throw new Error(`${label} must be between 1 minute and 7 days.`)
    }
    return x
  }
  return { costly: check(v.costlySeconds, 'The costly-command TTL'), default: check(v.defaultSeconds, 'The default TTL') }
}
