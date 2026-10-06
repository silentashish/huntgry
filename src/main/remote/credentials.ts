import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { BEARER } from '@shared/remote'
import { writeDurable } from './durable'

/**
 * The relay credentials (ADR-0001, "Credential storage and lifecycle"): relay URL, admin
 * token, room id and owner secret, in one blob encrypted by the app's `Cipher`
 * (Electron `safeStorage` in the app, a reversible stand-in in tests) at
 * `userData/remote/relay.json`. Nothing here talks to the relay; `relayFetch` only builds
 * the request rules every call must follow (https, bearer token, `redirect: 'error'`).
 */

export interface RelayCredentials {
  /** `https://host[:port]`, no path, no trailing slash. */
  relayUrl: string
  adminToken: string
  roomId: string
  /** base64 of 32 random bytes; presented as `auth.owner` and as the bearer token. */
  ownerSecret: string
}

/** Reversible encryption of a small string; `available()` false means nothing can be stored. */
export interface Cipher {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(blob: Buffer): string
}

export type CredentialsRead =
  | { status: 'none' }
  | { status: 'ok'; credentials: RelayCredentials }
  /** The file exists but cannot be decrypted or parsed; only rotation recovers (#37). */
  | { status: 'unreadable'; error: string }

export const RELAY_FILE = 'relay.json'

/**
 * Accepts a relay URL with the `https://` scheme only (no credentials, query or fragment) and
 * returns it normalised; throws a message for the Settings page otherwise.
 */
export function normalizeRelayUrl(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 2048) throw new Error('Enter the relay URL.')
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('The relay URL is not a valid URL.')
  }
  if (url.protocol !== 'https:') throw new Error('The relay URL must start with https:// (TLS only).')
  if (url.username || url.password) throw new Error('The relay URL must not carry credentials.')
  if (url.search || url.hash) throw new Error('The relay URL must not have a query or fragment.')
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** The WebSocket URL derived from a normalised relay URL: `https://` becomes `wss://`. */
export function socketUrl(relayUrl: string, path: string): string {
  return `wss://${relayUrl.slice('https://'.length)}${path}`
}

/** A fresh owner secret: base64 of 32 random bytes. */
export function newOwnerSecret(): string {
  return nodeRandomBytes(32).toString('base64')
}

export interface RelayRequest {
  url: string
  init: RequestInit & { redirect: 'error'; headers: Record<string, string> }
}

/**
 * The one way the desktop builds an HTTPS request to the relay: https only, the token as a
 * bearer header (never in the URL), `redirect: 'error'` so a credential is never sent after a
 * redirect or a downgrade, JSON in and out.
 */
export function relayRequest(relayUrl: string, path: string, token: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): RelayRequest {
  const url = `${normalizeRelayUrl(relayUrl)}${path}`
  const headers: Record<string, string> = { authorization: `${BEARER} ${token}`, accept: 'application/json' }
  const init: RelayRequest['init'] = { method, headers, redirect: 'error' }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return { url, init }
}

export class CredentialStore {
  constructor(
    private dir: string,
    private cipher: Cipher
  ) {}

  get file(): string {
    return join(this.dir, RELAY_FILE)
  }

  async read(): Promise<CredentialsRead> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' }
      return { status: 'unreadable', error: `relay.json cannot be read: ${(err as Error).message}` }
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; blob?: unknown }
      if (parsed.version !== 1 || typeof parsed.blob !== 'string') throw new Error('unknown file format')
      if (!this.cipher.available()) throw new Error('encryption is not available on this machine')
      const text = this.cipher.decrypt(Buffer.from(parsed.blob, 'base64'))
      const c = JSON.parse(text) as Partial<RelayCredentials>
      if (![c.relayUrl, c.adminToken, c.roomId, c.ownerSecret].every((v) => typeof v === 'string' && v.length > 0)) {
        throw new Error('fields missing')
      }
      return { status: 'ok', credentials: { relayUrl: normalizeRelayUrl(c.relayUrl), adminToken: c.adminToken!, roomId: c.roomId!, ownerSecret: c.ownerSecret! } }
    } catch (err) {
      return { status: 'unreadable', error: `Relay credentials unreadable (${(err as Error).message}). Rotate them in Settings.` }
    }
  }

  /** Encrypts and writes the blob atomically and durably (fsynced temp file + rename + directory fsync). */
  async write(credentials: RelayCredentials): Promise<void> {
    if (!this.cipher.available()) throw new Error('Encrypted storage is not available on this machine; relay credentials cannot be saved.')
    const blob = this.cipher.encrypt(JSON.stringify({ ...credentials, relayUrl: normalizeRelayUrl(credentials.relayUrl) })).toString('base64')
    await mkdir(dirname(this.file), { recursive: true })
    await writeDurable(this.file, `${JSON.stringify({ version: 1, blob }, null, 2)}\n`)
  }
}
