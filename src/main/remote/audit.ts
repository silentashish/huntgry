import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvelopeError } from '@shared/remote'
import { HUNTGRY_DIR } from '../workspace/constants'

/**
 * The remote audit log, `<workspace>/.huntgry/remote-audit.jsonl` (ADR-0001, "Delivery,
 * acknowledgement and idempotency"): the durable commit of every remote command.
 *
 * - `{ id, deviceId, seq, name, started: true }` is written and fsynced **before** a mutating
 *   command executes; `{ id, deviceId, seq, name, ok, result | error }` after it. Reads and
 *   rejected frames get only the second kind.
 * - `lastSeq` per device is derived from it on start (`devices.json` is a checkpoint).
 * - An index of the last `INDEX_SIZE` command ids answers redeliveries: a finished id
 *   returns its stored result, a started one is `interrupted`, an unknown one executes.
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
}

export type AuditEntry = AuditStart | AuditFinish

export type Known = { state: 'started' } | { state: 'finished'; ok: boolean; result?: unknown; error?: EnvelopeError; read?: true }

const INTERRUPTED: EnvelopeError = {
  code: 'failed',
  message: 'Huntgry was interrupted before this command completed. Check the queue on your Mac and send it again.'
}

export const interruptedError = (): EnvelopeError => ({ ...INTERRUPTED })

export class AuditLog {
  private index = new Map<string, Known>()
  private lastSeq = new Map<string, number>()
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
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
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
    }
    if ('started' in entry && entry.started) {
      this.index.set(entry.id, { state: 'started' })
    } else {
      const f = entry as AuditFinish
      // Rejected frames (no seq accepted) are not commands the phone can redeliver under the same id with success; keep them out of the index.
      if (f.seq === undefined) return
      const known: Known = { state: 'finished', ok: f.ok }
      if (f.result !== undefined) known.result = f.result
      if (f.error !== undefined) known.error = f.error
      if (f.read) known.read = true
      this.index.set(entry.id, known)
    }
    if (this.index.size > this.indexSize) {
      const oldest = this.index.keys().next().value
      if (oldest !== undefined) this.index.delete(oldest)
    }
  }

  /** What the log knows about a command id, or `null`. */
  lookup(id: string): Known | null {
    return this.index.get(id) ?? null
  }

  /** Highest `seq` the log proves accepted for a device (0 when none). */
  lastSeqOf(deviceId: string): number {
    return this.lastSeq.get(deviceId) ?? 0
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

  private append(entry: AuditEntry): Promise<void> {
    // Index first, so a lookup that races the write already sees the command as started.
    this.remember(entry)
    const line = `${JSON.stringify(entry)}\n`
    const run = async () => {
      await mkdir(join(this.file, '..'), { recursive: true })
      const handle = await open(this.file, 'a')
      try {
        await handle.appendFile(line, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    this.writing = this.writing.then(run, run)
    return this.writing
  }

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
