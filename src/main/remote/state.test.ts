import { describe, expect, it } from 'vitest'
import type { AuditEntry } from './audit'
import type { DeviceRecord } from './devices'
import { buildRemoteState, projectAudit } from './state'

/** What crosses IPC to Settings (#37): no secret, key, token hash, session id, result body or path. */

const SECRET_MARKERS = ['ADMIN_TOKEN_MARKER', 'OWNER_SECRET_MARKER', 'PUBLIC_KEY_MARKER', 'f'.repeat(64), 'SID_MARKER', 'RESULT_MARKER', '/Users/MARKER']

const device: DeviceRecord = {
  id: 'dev-1',
  name: 'Test iPhone',
  publicKey: 'PUBLIC_KEY_MARKER',
  tokenHash: 'f'.repeat(64),
  sid: 'SID_MARKER',
  pairedAt: '2026-10-09T10:00:00.000Z',
  lastSeen: '2026-10-09T11:00:00.000Z',
  lastSeq: 9,
  categories: ['needs-reply'],
  needsRepair: true
}

describe('buildRemoteState', () => {
  it('carries the relay URL, room, devices, pairings and settings, never a secret or key', () => {
    const state = buildRemoteState({
      settings: { enabled: true, notificationDetails: false, transcripts: true, commandTtl: { costly: 7200, default: 86400 } },
      credentials: { status: 'ok', credentials: { relayUrl: 'https://relay.example.com', adminToken: 'ADMIN_TOKEN_MARKER', roomId: 'room-1', ownerSecret: 'OWNER_SECRET_MARKER' } },
      session: { connection: 'online', onlineSince: '2026-10-09T11:00:00.000Z' },
      revokeWarning: null,
      devices: [device],
      pairings: [{ id: 'p-1', status: 'scanned', expiresAt: '2026-10-09T12:02:00.000Z', decideBy: '2026-10-09T12:07:00.000Z', deviceName: 'Test iPhone', appVersion: '1.0.0' }]
    })
    expect(state).toEqual({
      connection: 'online',
      relayUrl: 'https://relay.example.com',
      roomId: 'room-1',
      onlineSince: '2026-10-09T11:00:00.000Z',
      notificationDetails: false,
      transcripts: true,
      commandTtl: { costlySeconds: 7200, defaultSeconds: 86400 },
      devices: [{ id: 'dev-1', name: 'Test iPhone', pairedAt: '2026-10-09T10:00:00.000Z', lastSeen: '2026-10-09T11:00:00.000Z', needsRepair: true, categories: ['needs-reply'] }],
      pairings: [{ id: 'p-1', status: 'scanned', expiresAt: '2026-10-09T12:02:00.000Z', decideBy: '2026-10-09T12:07:00.000Z', deviceName: 'Test iPhone', appVersion: '1.0.0' }]
    })
    const json = JSON.stringify(state)
    for (const marker of SECRET_MARKERS) expect(json).not.toContain(marker)
  })

  it('unreadable credentials win over the session state and carry the recovery message', () => {
    const state = buildRemoteState({
      settings: { enabled: true, notificationDetails: false, transcripts: true, commandTtl: { costly: 7200, default: 86400 } },
      credentials: { status: 'unreadable', error: 'Relay credentials unreadable (decryption failed). Rotate them in Settings.' },
      session: { connection: 'offline' },
      revokeWarning: 'warning',
      devices: [],
      pairings: []
    })
    expect(state.connection).toBe('credentials-unreadable')
    expect(state.error).toMatch(/unreadable/)
    expect(state.relayUrl).toBeUndefined()
  })
})

describe('projectAudit', () => {
  it('one row per command (outcome replaces the write-ahead entry), newest first, names not ids, no results', () => {
    const entries: AuditEntry[] = [
      { ts: '2026-10-09T10:00:00.000Z', id: 'c1', deviceId: 'dev-1', seq: 1, name: 'queue.get', ok: true, read: true },
      { ts: '2026-10-09T10:01:00.000Z', id: 'c2', deviceId: 'dev-1', seq: 2, name: 'queue.setPaused', started: true },
      { ts: '2026-10-09T10:01:01.000Z', id: 'c2', deviceId: 'dev-1', seq: 2, name: 'queue.setPaused', ok: true, result: { marker: 'RESULT_MARKER' } },
      { ts: '2026-10-09T10:02:00.000Z', id: 'c3', deviceId: 'gone', seq: 1, name: 'run.reply', ok: false, error: { code: 'rate-limited', message: 'One reply every 2 s per run.' } },
      { ts: '2026-10-09T10:03:00.000Z', id: 'c4', deviceId: 'dev-1', seq: 3, name: 'queue.enqueue', started: true }
    ]
    const rows = projectAudit(entries, [device])
    expect(rows).toEqual([
      { ts: '2026-10-09T10:03:00.000Z', deviceId: 'dev-1', device: 'Test iPhone', command: 'queue.enqueue', outcome: 'started' },
      { ts: '2026-10-09T10:02:00.000Z', deviceId: 'gone', device: 'Removed phone', command: 'run.reply', outcome: 'failed', error: 'rate-limited: One reply every 2 s per run.' },
      { ts: '2026-10-09T10:01:00.000Z', deviceId: 'dev-1', device: 'Test iPhone', command: 'queue.setPaused', outcome: 'ok' },
      { ts: '2026-10-09T10:00:00.000Z', deviceId: 'dev-1', device: 'Test iPhone', command: 'queue.get', outcome: 'ok' }
    ])
    expect(JSON.stringify(rows)).not.toContain('RESULT_MARKER')
  })

  it('keeps the last 200', () => {
    const entries: AuditEntry[] = Array.from({ length: 250 }, (_, i) => ({ ts: new Date(i * 1000).toISOString(), id: `c${i}`, deviceId: 'dev-1', seq: i + 1, name: 'queue.get', ok: true }))
    const rows = projectAudit(entries, [device])
    expect(rows).toHaveLength(200)
    expect(rows[0].ts).toBe(new Date(249 * 1000).toISOString())
    expect(rows[199].ts).toBe(new Date(50 * 1000).toISOString())
  })
})
