import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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
    expect(log.lookup('c1')).toEqual({ state: 'started' })
    await log.finish({ id: 'c1', deviceId: 'd1', seq: 3, name: 'queue.setPaused', ok: true, result: { paused: true } })
    expect(log.lookup('c1')).toEqual({ state: 'finished', ok: true, result: { paused: true } })
    await log.finish({ id: 'c2', deviceId: 'd1', seq: 4, name: 'queue.get', ok: true, read: true })
    await log.finish({ id: 'c3', deviceId: 'd1', name: 'unknown', ok: false, error: { code: 'denied', message: 'x' } })

    const lines = (await readFile(auditFile(ws), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'c1', deviceId: 'd1', seq: 3, name: 'queue.setPaused', started: true })
    expect(JSON.parse(lines[0]).ts).toMatch(/^\d{4}-/)

    const again = AuditLog.forWorkspace(ws)
    await again.load()
    expect(again.lookup('c1')).toEqual({ state: 'finished', ok: true, result: { paused: true } })
    expect(again.lookup('c2')).toEqual({ state: 'finished', ok: true, read: true })
    expect(again.lookup('c3')).toBeNull() // rejected before a seq was accepted: not a redeliverable command
    expect(again.lastSeqOf('d1')).toBe(4)
    expect(again.lastSeqOf('other')).toBe(0)
  })

  it('derives lastSeq from a started-only entry (crash between the two writes) and reports it as interrupted', async () => {
    const log = AuditLog.forWorkspace(ws)
    await log.load()
    await log.start({ id: 'c9', deviceId: 'd1', seq: 9, name: 'run.reply' })
    const again = AuditLog.forWorkspace(ws)
    await again.load()
    expect(again.lookup('c9')).toEqual({ state: 'started' })
    expect(again.lastSeqOf('d1')).toBe(9)
  })

  it('skips a torn last line and keeps only the last `indexSize` ids (10 000 in the app)', async () => {
    expect(INDEX_SIZE).toBe(10_000)
    const size = 50
    const log = new AuditLog(auditFile(ws), size)
    await log.load()
    for (let i = 0; i < size + 5; i++) await log.finish({ id: `c${i}`, deviceId: 'd1', seq: i + 1, name: 'queue.get', ok: true, read: true })
    expect(log.lookup('c0')).toBeNull()
    expect(log.lookup(`c${size + 4}`)).not.toBeNull()
    await appendFile(auditFile(ws), '{"id":"torn","deviceId":"d1","seq":')
    const again = new AuditLog(auditFile(ws), size)
    await expect(again.load()).resolves.toBeUndefined()
    expect(again.lastSeqOf('d1')).toBe(size + 5)
    expect(again.lookup('c4')).toBeNull()
    expect(again.lookup('c5')).not.toBeNull()
  })
})
