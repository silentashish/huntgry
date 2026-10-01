import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deriveSessionKey,
  fromBase64,
  generateKeyPair,
  keyPairFromSecretKey,
  NOTIFICATION_CATEGORIES,
  toBase64,
  type KeyPair,
  type NotificationCategory
} from '@shared/remote'
import type { Cipher } from './credentials'

/**
 * Paired devices and the desktop identity (ADR-0001, "Keys and storage", "Replay and
 * ordering"). `userData/remote/devices.json` holds the device records (id, name, public key,
 * relay-token hash, pairing time, last seen, notification categories, `needsRepair`) and the
 * replay checkpoint: each device's `lastSeq` and the desktop's outgoing `seq`. It is written
 * atomically (temp file + rename) after every accepted or sent frame, and only ever read as
 * a checkpoint: on start the gateway raises `lastSeq` to what the audit log proves.
 * The desktop's X25519 secret key is in `desktop-key.json`, encrypted by the `Cipher`
 * (`safeStorage` in the app).
 */

export interface DeviceRecord {
  id: string
  name: string
  /** base64, 32 bytes. */
  publicKey: string
  /** Hex SHA-256 of the device's relay token (the token itself lives on the phone). */
  tokenHash: string
  /** Session id agreed at pairing; every `Envelope.sid` from or to this device. */
  sid: string
  pairedAt: string
  lastSeen?: string
  /** Highest `Envelope.seq` accepted from this device. */
  lastSeq: number
  categories: NotificationCategory[]
  /** The phone's counter rewound: nothing runs from it until it pairs again. */
  needsRepair: boolean
}

interface DevicesFile {
  version: 1
  outSeq: number
  devices: DeviceRecord[]
}

export const DEVICES_FILE = 'devices.json'
export const DESKTOP_KEY_FILE = 'desktop-key.json'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function sanitizeDevice(v: unknown): DeviceRecord | null {
  if (!isRecord(v)) return null
  const str = (x: unknown, max = 200) => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : null)
  const id = str(v.id, 128)
  const publicKey = str(v.publicKey, 64)
  const sid = str(v.sid, 128)
  const tokenHash = str(v.tokenHash, 64)
  const pairedAt = str(v.pairedAt, 64)
  if (!id || !publicKey || !sid || !tokenHash || !pairedAt) return null
  try {
    if (fromBase64(publicKey).length !== 32) return null
  } catch {
    return null
  }
  const categories = Array.isArray(v.categories)
    ? v.categories.filter((c): c is NotificationCategory => (NOTIFICATION_CATEGORIES as readonly unknown[]).includes(c))
    : []
  const out: DeviceRecord = {
    id,
    name: str(v.name) ?? 'Phone',
    publicKey,
    tokenHash,
    sid,
    pairedAt,
    lastSeq: typeof v.lastSeq === 'number' && Number.isInteger(v.lastSeq) && v.lastSeq >= 0 ? v.lastSeq : 0,
    categories: [...new Set(categories)],
    needsRepair: v.needsRepair === true
  }
  const lastSeen = str(v.lastSeen, 64)
  if (lastSeen) out.lastSeen = lastSeen
  return out
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

export class DeviceStore {
  private devices = new Map<string, DeviceRecord>()
  private outSeq = 0
  private keys: KeyPair | null = null
  private sessionKeys = new Map<string, Uint8Array>()
  private saving: Promise<void> = Promise.resolve()
  /** The `outSeq` value the pending write (if any) will persist. */
  private queuedSeq = -1
  private loaded = false

  constructor(
    private dir: string,
    private cipher: Cipher
  ) {}

  get file(): string {
    return join(this.dir, DEVICES_FILE)
  }

  get keyFile(): string {
    return join(this.dir, DESKTOP_KEY_FILE)
  }

  /** Reads the checkpoint and the desktop key (generating the key on first use). */
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    this.devices.clear()
    this.sessionKeys.clear()
    this.outSeq = 0
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<DevicesFile>
      if (typeof raw.outSeq === 'number' && Number.isInteger(raw.outSeq) && raw.outSeq >= 0) this.outSeq = raw.outSeq
      for (const d of Array.isArray(raw.devices) ? raw.devices : []) {
        const record = sanitizeDevice(d)
        if (record) this.devices.set(record.id, record)
      }
    } catch {
      // Missing or broken checkpoint: the audit log raises lastSeq again on start.
    }
    this.keys = await this.readKey()
    this.loaded = true
  }

  private async readKey(): Promise<KeyPair | null> {
    try {
      const raw = JSON.parse(await readFile(this.keyFile, 'utf8')) as { version?: unknown; blob?: unknown }
      if (raw.version === 1 && typeof raw.blob === 'string' && this.cipher.available()) {
        const secret = fromBase64(this.cipher.decrypt(Buffer.from(raw.blob, 'base64')))
        return keyPairFromSecretKey(secret)
      }
    } catch {
      // Unreadable: treated as absent; every device must pair again once a key exists.
    }
    return null
  }

  /** The desktop keypair, generated and stored on first use. `null` when nothing can be encrypted. */
  async keyPair(): Promise<KeyPair | null> {
    if (this.keys) return this.keys
    if (!this.cipher.available()) return null
    const pair = generateKeyPair()
    await this.writeKey(pair)
    this.keys = pair
    return pair
  }

  private async writeKey(pair: KeyPair): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const blob = this.cipher.encrypt(toBase64(pair.secretKey)).toString('base64')
    await writeAtomic(this.keyFile, `${JSON.stringify({ version: 1, publicKey: toBase64(pair.publicKey), blob }, null, 2)}\n`)
  }

  /** New desktop identity; every paired device is dropped (they pair again). */
  async rotateKeyPair(): Promise<KeyPair> {
    const pair = generateKeyPair()
    await this.writeKey(pair)
    this.keys = pair
    this.devices.clear()
    this.sessionKeys.clear()
    await this.save()
    return pair
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].map((d) => ({ ...d, categories: [...d.categories] }))
  }

  get(id: string): DeviceRecord | null {
    const d = this.devices.get(id)
    return d ? { ...d, categories: [...d.categories] } : null
  }

  /** Devices that may talk: paired and not marked for re-pairing. */
  active(): DeviceRecord[] {
    return this.list().filter((d) => !d.needsRepair)
  }

  async add(record: DeviceRecord): Promise<void> {
    this.devices.set(record.id, { ...record, categories: [...record.categories] })
    this.sessionKeys.delete(record.id)
    await this.save()
  }

  async remove(id: string): Promise<boolean> {
    const had = this.devices.delete(id)
    this.sessionKeys.delete(id)
    if (had) await this.save()
    return had
  }

  async update(id: string, patch: Partial<Pick<DeviceRecord, 'name' | 'categories' | 'needsRepair' | 'lastSeen'>>): Promise<DeviceRecord | null> {
    const d = this.devices.get(id)
    if (!d) return null
    Object.assign(d, patch)
    await this.save()
    return this.get(id)
  }

  /** The shared box key for a device (`nacl.box.before`), derived once per load. */
  async sessionKey(id: string): Promise<Uint8Array | null> {
    const cached = this.sessionKeys.get(id)
    if (cached) return cached
    const d = this.devices.get(id)
    const keys = await this.keyPair()
    if (!d || !keys) return null
    const key = deriveSessionKey(fromBase64(d.publicKey), keys.secretKey)
    this.sessionKeys.set(id, key)
    return key
  }

  /** Raises a device's `lastSeq` (never lowers it), e.g. from the audit log on start. */
  raiseLastSeq(id: string, seq: number): void {
    const d = this.devices.get(id)
    if (d && seq > d.lastSeq) d.lastSeq = seq
  }

  /** Records an accepted frame: `lastSeq`, `lastSeen`; resolves once the checkpoint is on disk. */
  async accept(id: string, seq: number, at: string): Promise<void> {
    const d = this.devices.get(id)
    if (!d) return
    if (seq > d.lastSeq) d.lastSeq = seq
    d.lastSeen = at
    await this.save()
  }

  /** Marks a device as needing re-pair (rewound counter); nothing runs from it until then. */
  async markNeedsRepair(id: string): Promise<void> {
    const d = this.devices.get(id)
    if (!d || d.needsRepair) return
    d.needsRepair = true
    await this.save()
  }

  /**
   * The next outgoing `seq`. The checkpoint is written *before* the frame is sent, so a crash
   * between the two can never reuse a number; concurrent reservations share one write.
   */
  nextOutSeq(): { seq: number; persisted: Promise<void> } {
    const seq = ++this.outSeq
    return { seq, persisted: this.save() }
  }

  currentOutSeq(): number {
    return this.outSeq
  }

  /** Serialised atomic write; writes queued while one is in flight collapse into a single later write. */
  private save(): Promise<void> {
    if (!this.loaded) return Promise.resolve()
    if (this.queuedSeq >= this.outSeq && this.queuedSeq !== -1) return this.saving
    this.queuedSeq = this.outSeq
    const run = async () => {
      this.queuedSeq = -1
      const body: DevicesFile = { version: 1, outSeq: this.outSeq, devices: this.list() }
      await mkdir(this.dir, { recursive: true })
      await writeAtomic(this.file, `${JSON.stringify(body, null, 2)}\n`)
    }
    this.saving = this.saving.then(run, run)
    return this.saving
  }

  /** Resolves once every queued write is on disk (shutdown, tests). */
  flush(): Promise<void> {
    return this.saving
  }
}
