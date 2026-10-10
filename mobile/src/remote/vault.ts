/**
 * Everything the phone keeps between launches, in the secure store (ADR-0001, "Phone
 * persistence"; #38): the device keypair, the pairing (device id, relay token, desktop public
 * key, derived session key, sid, relay URL, room), the outgoing `seq`, the desktop's `lastSeq`
 * and the last `StatusSummary`. Nothing else: transcripts, queue items and results live in
 * memory only and are gone when the app is closed.
 */

import {
  NOTIFICATION_CATEGORIES,
  fromBase64,
  fromHex,
  generateKeyPair,
  keyPairFromSecretKey,
  requireRelayUrl,
  requireStatusSummary,
  toBase64,
  type KeyPair,
  type NotificationCategory,
  type StatusSummary
} from '@huntgry/remote-protocol'
import type { SecureStorage } from './platform'

/** expo-secure-store keys: letters, digits, `.`, `-` and `_` only. */
export const VAULT_KEYS = {
  identity: 'huntgry.identity',
  pairing: 'huntgry.pairing',
  seq: 'huntgry.seq',
  lastSeq: 'huntgry.lastSeq',
  status: 'huntgry.status'
} as const

export interface Pairing {
  /** `https://` relay URL from the QR. */
  relay: string
  room: string
  deviceId: string
  /** 64 hex; presented in the socket's first frame, never in the URL. */
  relayToken: string
  /** Hex, 32 bytes. */
  desktopPublicKey: string
  /** Base64, 32 bytes: `nacl.box.before(desktopPub, devicePriv)`. */
  sessionKey: string
  sid: string
  desktopName: string
  /** The name this phone gives itself in `hello` (editable in Settings). */
  deviceName: string
  pairedAt: string
  /** The notification categories last sent with `device.setNotifications` (the desktop keeps the real list). */
  categories: NotificationCategory[]
}

export interface StoredStatus {
  status: StatusSummary
  at: string
}

const HEX64 = /^[0-9a-f]{64}$/

function parsePairing(text: string | null): Pairing | null {
  if (!text) return null
  try {
    const p = JSON.parse(text) as Record<string, unknown>
    const str = (k: string) => {
      const v = p[k]
      if (typeof v !== 'string' || v.length === 0 || v.length > 512) throw new Error(k)
      return v
    }
    const categories = Array.isArray(p.categories)
      ? (p.categories as unknown[]).filter((c): c is NotificationCategory => (NOTIFICATION_CATEGORIES as readonly unknown[]).includes(c))
      : [...NOTIFICATION_CATEGORIES]
    const out: Pairing = {
      relay: requireRelayUrl(p.relay),
      room: str('room'),
      deviceId: str('deviceId'),
      relayToken: str('relayToken'),
      desktopPublicKey: str('desktopPublicKey'),
      sessionKey: str('sessionKey'),
      sid: str('sid'),
      desktopName: str('desktopName'),
      deviceName: str('deviceName'),
      pairedAt: str('pairedAt'),
      categories
    }
    if (!HEX64.test(out.relayToken) || !HEX64.test(out.desktopPublicKey) || fromBase64(out.sessionKey).length !== 32) throw new Error('keys')
    return out
  } catch {
    return null
  }
}

function parseCounter(text: string | null, sid: string): number {
  if (!text) return 0
  try {
    const c = JSON.parse(text) as { sid?: unknown; seq?: unknown }
    // A counter of another session is not ours: start from 0 (a rewind the desktop answers with `denied`).
    if (c.sid !== sid || typeof c.seq !== 'number' || !Number.isSafeInteger(c.seq) || c.seq < 0) return 0
    return c.seq
  } catch {
    return 0
  }
}

export class Vault {
  private seq = 0
  private lastSeq = 0
  private sid: string | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: SecureStorage) {}

  // ── identity ──────────────────────────────────────────────────────────────────────────

  /** A fresh X25519 keypair for this phone, stored before anything uses it. Replaces any earlier identity. */
  async createIdentity(): Promise<KeyPair> {
    const pair = generateKeyPair()
    await this.storage.setItem(VAULT_KEYS.identity, JSON.stringify({ secretKey: toBase64(pair.secretKey) }))
    return pair
  }

  async loadIdentity(): Promise<KeyPair | null> {
    const text = await this.storage.getItem(VAULT_KEYS.identity)
    if (!text) return null
    try {
      const { secretKey } = JSON.parse(text) as { secretKey: string }
      return keyPairFromSecretKey(fromBase64(secretKey))
    } catch {
      return null
    }
  }

  // ── pairing ───────────────────────────────────────────────────────────────────────────

  async loadPairing(): Promise<Pairing | null> {
    const pairing = parsePairing(await this.storage.getItem(VAULT_KEYS.pairing))
    if (!pairing) return null
    this.sid = pairing.sid
    this.seq = parseCounter(await this.storage.getItem(VAULT_KEYS.seq), pairing.sid)
    this.lastSeq = parseCounter(await this.storage.getItem(VAULT_KEYS.lastSeq), pairing.sid)
    return pairing
  }

  /** A new pairing starts both counters at 0 for its `sid`. */
  async savePairing(pairing: Pairing): Promise<void> {
    await this.storage.setItem(VAULT_KEYS.pairing, JSON.stringify(pairing))
    if (this.sid !== pairing.sid) {
      this.sid = pairing.sid
      this.seq = 0
      this.lastSeq = 0
      await this.storage.setItem(VAULT_KEYS.seq, JSON.stringify({ sid: pairing.sid, seq: 0 }))
      await this.storage.setItem(VAULT_KEYS.lastSeq, JSON.stringify({ sid: pairing.sid, seq: 0 }))
    }
  }

  /** Changes to the stored pairing that keep the session (device name, notification categories). */
  async updatePairing(pairing: Pairing): Promise<void> {
    await this.storage.setItem(VAULT_KEYS.pairing, JSON.stringify(pairing))
  }

  // ── counters ──────────────────────────────────────────────────────────────────────────

  /**
   * The next outgoing `seq`: one counter per `sid` for every kind the phone sends, strictly
   * increasing, written to the secure store **before** the frame that carries it is sent. A
   * failed write rejects, and nothing is sent with that number.
   */
  nextSeq(): Promise<number> {
    const run = this.chain.then(async () => {
      if (this.sid === null) throw new Error('Not paired.')
      const next = this.seq + 1
      await this.storage.setItem(VAULT_KEYS.seq, JSON.stringify({ sid: this.sid, seq: next }))
      this.seq = next
      return next
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  get currentSeq(): number {
    return this.seq
  }

  get desktopLastSeq(): number {
    return this.lastSeq
  }

  /** Records the desktop's `seq` of a processed frame. Gaps are normal (its counter is shared by every device). */
  acceptDesktopSeq(seq: number): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.sid === null || seq <= this.lastSeq) return
      await this.storage.setItem(VAULT_KEYS.lastSeq, JSON.stringify({ sid: this.sid, seq }))
      this.lastSeq = seq
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  // ── last status ───────────────────────────────────────────────────────────────────────

  async saveStatus(status: StatusSummary, at: string): Promise<void> {
    await this.storage.setItem(VAULT_KEYS.status, JSON.stringify({ status, at }))
  }

  async loadStatus(): Promise<StoredStatus | null> {
    const text = await this.storage.getItem(VAULT_KEYS.status)
    if (!text) return null
    try {
      const parsed = JSON.parse(text) as { status: unknown; at: unknown }
      if (typeof parsed.at !== 'string') return null
      return { status: requireStatusSummary(parsed.status), at: parsed.at }
    } catch {
      return null
    }
  }

  // ── wipe ──────────────────────────────────────────────────────────────────────────────

  /** Unpair, `device.revoked`, a `denied` "pair again": every key, counter and the last status. */
  async wipe(): Promise<void> {
    this.sid = null
    this.seq = 0
    this.lastSeq = 0
    for (const key of Object.values(VAULT_KEYS)) await this.storage.deleteItem(key)
  }
}

/** Hex of a stored desktop key, as bytes. */
export function desktopKey(pairing: Pairing): Uint8Array {
  return fromHex(pairing.desktopPublicKey)
}
