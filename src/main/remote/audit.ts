import { mkdir, open, readFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvelopeError } from '@shared/remote'
import { HUNTGRY_DIR } from '../workspace/constants'
import { syncDir } from './durable'

/**
 * The remote audit log, `<workspace>/.huntgry/remote-audit.jsonl` (ADR-0001, "Delivery,
 * acknowledgement and idempotency"): the durable commit of every remote command.
 *
 * - `{ id, deviceId, seq, name, started: true }` is written and fsynced **before** a mutating
 *   command executes; `{ id, deviceId, seq, name, ok, result | error }` after it. Reads and
 *   rejected frames get only the second kind.
 * - `lastSeq` per device is derived from it on start (`devices.json` is a checkpoint), per
 *   pairing: entries carry the pairing's `sid`, so a phone paired again under the same device
 *   id (counter back at 0) is not held to the old pairing's sequence.
 * - An index of the last `INDEX_SIZE` (device, command id) pairs answers redeliveries: a
 *   finished id returns its stored result, a started one is `interrupted`, an unknown one
 *   executes. Each entry keeps the original `seq` and a digest of the envelope, so only an
 *   exact redelivery is answered from the log; a reused id with other content is refused.
 * - A torn last record (crash mid-append) is cut off on load, before anything is appended.
 */

export const AUDIT_FILE = 'remote-audit.jsonl'
export const INDEX_SIZE = 10_000

export const auditFile = (workspace: string): string => join(workspace, HUNTGRY_DIR, AUDIT_FILE)

export interface AuditStart {
  ts: string
  id: string
  deviceId: string
  seq: number
  name: string
  /** `envelopeDigest` of the command, so a redelivery can be told from a reused id. */
  digest?: string
  /** The pairing (`DeviceRecord.sid`) the frame came under. */
  sid?: string
  started: true
}

export interface AuditFinish {
  ts: string
  id: string
  deviceId: string
  /** Absent when the frame was rejected before its `seq` was accepted (bad box, foreign session). */
  seq?: number
  name: string
  ok: boolean
  /** The result body sent to the phone (mutating commands only; reads store nothing). */
  result?: unknown
  error?: EnvelopeError
  /** A read: no write-ahead entry, may run again on redelivery. */
  read?: true
  digest?: string
  sid?: string
}

export type AuditEntry = AuditStart | AuditFinish

/** What the log knows about one (device, id): the outcome plus the identity it was accepted under. */
export type Known = ({ state: 'started' } | { state: 'finished'; ok: boolean; result?: unknown; error?: EnvelopeError; read?: true }) & { seq?: number; digest?: string }

const key = (deviceId: string, id: string): string => `${deviceId}\u0000${id}`

const INTERRUPTED: EnvelopeError = {
  code: 'failed',
  message: 'Huntgry was interrupted before this command completed. Check the queue on your Mac and send it again.'
}

export const interruptedError = (): EnvelopeError => ({ ...INTERRUPTED })

export class AuditLog {
  private index = new Map<string, Known>()
  private lastSeq = new Map<string, number>()
  /** Highest seq per (device, pairing sid). */
  private lastSeqBySid = new Map<string, number>()
  /** Entries written before `sid` was recorded: their seq and time, per device. */
  private legacy = new Map<string, { seq: number; ts: string }[]>()
  private writing: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private indexSize = INDEX_SIZE
  ) {}

  static forWorkspace(workspace: string): AuditLog {
    return new AuditLog(auditFile(workspace))
  }

  /** Rebuilds the id index and the per-device `lastSeq` from the file (missing file = empty). */
  async load(): Promise<void> {
    this.index.clear()
    this.lastSeq.clear()
    this.lastSeqBySid.clear()
    this.legacy.clear()
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    if (text.length > 0 && !text.endsWith('\n')) {
      // A crash mid-append left an unterminated record. Appending after it would glue the next
      // (fsynced) entry onto the torn bytes and make it unreadable, so cut back to the last newline.
      const keep = text.lastIndexOf('\n') + 1
      await truncate(this.file, Buffer.byteLength(text.slice(0, keep), 'utf8'))
      const handle = await open(this.file, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      text = text.slice(0, keep)
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry: AuditEntry
      try {
        entry = JSON.parse(line) as AuditEntry
      } catch {
        continue // a torn last line from a crash mid-append
      }
      if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string' || typeof entry.deviceId !== 'string') continue
      this.remember(entry)
    }
  }

  private remember(entry: AuditEntry): void {
    if (typeof entry.seq === 'number') {
      const prev = this.lastSeq.get(entry.deviceId) ?? 0
      if (entry.seq > prev) this.lastSeq.set(entry.deviceId, entry.seq)
      if (typeof entry.sid === 'string') {
        const k = key(entry.deviceId, entry.sid)
        if (entry.seq > (this.lastSeqBySid.get(k) ?? 0)) this.lastSeqBySid.set(k, entry.seq)
      } else {
        const list = this.legacy.get(entry.deviceId) ?? []
        list.push({ seq: entry.seq, ts: typeof entry.ts === 'string' ? entry.ts : '' })
        this.legacy.set(entry.deviceId, list)
      }
    }
    const k = key(entry.deviceId, entry.id)
    const identity = (known: Known): Known => {
      if (typeof entry.seq === 'number') known.seq = entry.seq
      if (typeof entry.digest === 'string') known.digest = entry.digest
      return known
    }
    if ('started' in entry && entry.started) {
      this.index.delete(k)
      this.index.set(k, identity({ state: 'started' }))
    } else {
      const f = entry as AuditFinish
      // Rejected frames (no seq accepted) are not commands the phone can redeliver under the same id with success; keep them out of the index.
      if (f.seq === undefined) return
      const known: Known = { state: 'finished', ok: f.ok }
      if (f.result !== undefined) known.result = f.result
      if (f.error !== undefined) known.error = f.error
      if (f.read) known.read = true
      this.index.delete(k)
      this.index.set(k, identity(known))
    }
    if (this.index.size > this.indexSize) {
      const oldest = this.index.keys().next().value
      if (oldest !== undefined) this.index.delete(oldest)
    }
  }

  /** What the log knows about a device's command id, or `null`. */
  lookup(deviceId: string, id: string): Known | null {
    return this.index.get(key(deviceId, id)) ?? null
  }

  /** Highest `seq` the log proves accepted for a device (0 when none). */
  /**
   * Highest `seq` the log proves accepted for a device: for `pairing`, only under that pairing's
   * `sid`, plus entries without a `sid` written at or after `pairedAt` (older logs); without
   * `pairing`, over every pairing.
   */
  lastSeqOf(deviceId: string, pairing?: { sid: string; pairedAt: string }): number {
    if (!pairing) return this.lastSeq.get(deviceId) ?? 0
    let max = this.lastSeqBySid.get(key(deviceId, pairing.sid)) ?? 0
    const since = Date.parse(pairing.pairedAt)
    for (const e of this.legacy.get(deviceId) ?? []) {
      if (e.seq > max && Date.parse(e.ts) >= since) max = e.seq
    }
    return max
  }

  /** Appends the write-ahead entry and fsyncs; resolves only when it is durable. */
  start(entry: Omit<AuditStart, 'started' | 'ts'> & { ts?: string }): Promise<void> {
    const full: AuditStart = { ts: entry.ts ?? new Date().toISOString(), ...entry, started: true }
    return this.append(full)
  }

  /** Appends the outcome and fsyncs. */
  finish(entry: Omit<AuditFinish, 'ts'> & { ts?: string }): Promise<void> {
    const full: AuditFinish = { ts: entry.ts ?? new Date().toISOString(), ...entry }
    return this.append(full)
  }

  /**
   * Appends one record and fsyncs, then indexes it: a lookup never answers from an entry that
   * is not on disk. A failed write rejects (the gateway then leaves the frame unacked).
   */
  private append(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`
    const run = async () => {
      const dir = join(this.file, '..')
      await mkdir(dir, { recursive: true })
      const handle = await open(this.file, 'a')
      try {
        await handle.appendFile(line, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (!this.created) {
        await syncDir(dir)
        this.created = true
      }
      this.remember(entry)
    }
    const next = this.writing.then(run, run)
    this.writing = next.catch(() => undefined)
    return next
  }

  /** Whether the file's directory entry was fsynced once in this process. */
  private created = false

  /** Every entry, oldest first (Settings shows the last few). */
  async entries(limit = 200): Promise<AuditEntry[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter((l) => l.trim())
    return lines.slice(-limit).flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry]
      } catch {
        return []
      }
    })
  }
}
