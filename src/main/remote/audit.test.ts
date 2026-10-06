import { appendFile, chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog, auditFile, INDEX_SIZE } from './audit'

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-audit-'))
})
afterEach(() => rm(ws, { recursive: true, force: true }))

describe('AuditLog', () => {
  it('writes the write-ahead entry before the outcome and rebuilds the index from the file', async () => {
    const log = AuditLog.forWorkspace(ws)
    await log.load()
    await log.start({ id: 'c1', deviceId: 'd1', seq: 3, name: 'queue.setPaused' })
    expect(log.lookup('d1', 'c1')).toMatchObject({ state: 'started' })
    await log.finish({ id: 'c1', deviceId: 'd1', seq: 3, name: 'queue.setPaused', ok: true, result: { paused: true } })
    expect(log.lookup('d1', 'c1')).toMatchObject({ state: 'finished', ok: true, result: { paused: true } })
    await log.finish({ id: 'c2', deviceId: 'd1', seq: 4, name: 'queue.get', ok: true, read: true })
    await log.finish({ id: 'c3', deviceId: 'd1', name: 'unknown', ok: false, error: { code: 'denied', message: 'x' } })

    const lines = (await readFile(auditFile(ws), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'c1', deviceId: 'd1', seq: 3, name: 'queue.setPaused', started: true })
    expect(JSON.parse(lines[0]).ts).toMatch(/^\d{4}-/)

    const again = AuditLog.forWorkspace(ws)
    await again.load()
    expect(again.lookup('d1', 'c1')).toMatchObject({ state: 'finished', ok: true, result: { paused: true } })
    expect(again.lookup('d1', 'c2')).toMatchObject({ state: 'finished', ok: true, read: true })
    expect(again.lookup('d1', 'c3')).toBeNull() // rejected before a seq was accepted: not a redeliverable command
    expect(again.lastSeqOf('d1')).toBe(4)
    expect(again.lastSeqOf('other')).toBe(0)
  })

  it('derives lastSeq from a started-only entry (crash between the two writes) and reports it as interrupted', async () => {
    const log = AuditLog.forWorkspace(ws)
    await log.load()
    await log.start({ id: 'c9', deviceId: 'd1', seq: 9, name: 'run.reply' })
    const again = AuditLog.forWorkspace(ws)
    await again.load()
    expect(again.lookup('d1', 'c9')).toMatchObject({ state: 'started' })
    expect(again.lastSeqOf('d1')).toBe(9)
  })

  it('skips a torn last line and keeps only the last `indexSize` ids (10 000 in the app)', async () => {
    expect(INDEX_SIZE).toBe(10_000)
    const size = 50
    const log = new AuditLog(auditFile(ws), size)
    await log.load()
    for (let i = 0; i < size + 5; i++) await log.finish({ id: `c${i}`, deviceId: 'd1', seq: i + 1, name: 'queue.get', ok: true, read: true })
    expect(log.lookup('d1', 'c0')).toBeNull()
    expect(log.lookup('d1', `c${size + 4}`)).not.toBeNull()
    await appendFile(auditFile(ws), '{"id":"torn","deviceId":"d1","seq":')
    const again = new AuditLog(auditFile(ws), size)
    await expect(again.load()).resolves.toBeUndefined()
    expect(again.lastSeqOf('d1')).toBe(size + 5)
    expect(again.lookup('d1', 'c4')).toBeNull()
    expect(again.lookup('d1', 'c5')).not.toBeNull()
  })

  it('cuts a torn tail before appending, so the next fsynced entry survives the next restart', async () => {
    const log = AuditLog.forWorkspace(ws)
    await log.load()
    await log.finish({ id: 'c1', deviceId: 'd1', seq: 1, name: 'queue.get', ok: true, read: true })
    await appendFile(auditFile(ws), '{"id":"torn","deviceId":"d1","seq":')
    const restarted = AuditLog.forWorkspace(ws)
    await restarted.load()
    expect((await readFile(auditFile(ws), 'utf8')).endsWith('\n')).toBe(true)
    await restarted.start({ id: 'c2', deviceId: 'd1', seq: 2, name: 'queue.setPaused' })
    const again = AuditLog.forWorkspace(ws)
    await again.load()
    expect(again.lookup('d1', 'c2')).toMatchObject({ state: 'started', seq: 2 })
    expect(again.lastSeqOf('d1')).toBe(2)
  })

  it('keeps ids per device and remembers the seq and digest each was accepted under', async () => {
    const log = AuditLog.forWorkspace(ws)
    await log.load()
    await log.start({ id: 'same', deviceId: 'd1', seq: 4, name: 'queue.setPaused', digest: 'aa' })
    expect(log.lookup('d2', 'same')).toBeNull()
    expect(log.lookup('d1', 'same')).toEqual({ state: 'started', seq: 4, digest: 'aa' })
  })

  it('indexes an entry only once it is on disk; a failed write rejects and leaves no trace', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const log = AuditLog.forWorkspace(ws)
    await log.load()
    await log.finish({ id: 'c1', deviceId: 'd1', seq: 1, name: 'queue.get', ok: true, read: true })
    await chmod(auditFile(ws), 0o400)
    await expect(log.start({ id: 'c2', deviceId: 'd1', seq: 2, name: 'queue.setPaused' })).rejects.toThrow()
    expect(log.lookup('d1', 'c2')).toBeNull()
    expect(log.lastSeqOf('d1')).toBe(1)
    await chmod(auditFile(ws), 0o600)
    // The log keeps working after the failure.
    await log.start({ id: 'c3', deviceId: 'd1', seq: 2, name: 'queue.setPaused' })
    expect(log.lookup('d1', 'c3')).toMatchObject({ state: 'started' })
  })

  it('derives lastSeq per pairing sid; entries without a sid count only from the current pairing on', async () => {
    const log = AuditLog.forWorkspace(ws)
    await log.load()
    await log.finish({ id: 'legacy-old', deviceId: 'd1', seq: 9, name: 'queue.get', ok: true, read: true, ts: '2026-09-01T00:00:00.000Z' })
    await log.finish({ id: 'a1', deviceId: 'd1', sid: 'sid-a', seq: 7, name: 'queue.get', ok: true, read: true })
    await log.finish({ id: 'legacy-new', deviceId: 'd1', seq: 2, name: 'queue.get', ok: true, read: true, ts: '2026-10-02T00:00:00.000Z' })
    await log.finish({ id: 'b1', deviceId: 'd1', sid: 'sid-b', seq: 1, name: 'queue.get', ok: true, read: true })
    const again = AuditLog.forWorkspace(ws)
    await again.load()
    expect(again.lastSeqOf('d1')).toBe(9)
    expect(again.lastSeqOf('d1', { sid: 'sid-b', pairedAt: '2026-10-01T00:00:00.000Z' })).toBe(2)
    expect(again.lastSeqOf('d1', { sid: 'sid-a', pairedAt: '2026-08-01T00:00:00.000Z' })).toBe(9)
  })
})

