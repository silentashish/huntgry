import type { RemoteAuditEntry, RemotePairingInfo, RemoteState } from '@shared/remote-types'
import type { AuditEntry } from './audit'
import type { CredentialsRead } from './credentials'
import type { DeviceRecord } from './devices'
import type { SessionState } from './session'
import type { RemoteSettings } from './settings'

/**
 * What the Settings page gets (#37), built from the stores by explicit field picks: the relay
 * URL and room id but never the admin token or owner secret, device names and dates but never a
 * public key, token hash or session id, pairing status but never a secret, and audit outcomes
 * but never a result body or a workspace path. Electron-free so the boundary is tested.
 */

export interface StateInput {
  settings: RemoteSettings
  credentials: CredentialsRead
  session: SessionState
  revokeWarning: string | null
  devices: DeviceRecord[]
  pairings: RemotePairingInfo[]
}

export function buildRemoteState(input: StateInput): RemoteState {
  const { settings, credentials, session: s } = input
  const state: RemoteState = {
    connection: !settings.enabled ? 'disabled' : credentials.status === 'unreadable' ? 'credentials-unreadable' : credentials.status === 'none' ? 'unconfigured' : s.connection,
    notificationDetails: settings.notificationDetails,
    transcripts: settings.transcripts,
    commandTtl: { costlySeconds: settings.commandTtl.costly, defaultSeconds: settings.commandTtl.default },
    devices: input.devices.map((d) => {
      const info: RemoteState['devices'][number] = { id: d.id, name: d.name, pairedAt: d.pairedAt, needsRepair: d.needsRepair, categories: [...d.categories] }
      if (d.lastSeen) info.lastSeen = d.lastSeen
      return info
    }),
    pairings: input.pairings.map((p) => ({ ...p }))
  }
  if (credentials.status === 'unreadable') state.error = credentials.error
  else if (input.revokeWarning) state.error = input.revokeWarning
  else if (s.error && settings.enabled) state.error = s.error
  if (credentials.status === 'ok') {
    state.relayUrl = credentials.credentials.relayUrl
    state.roomId = credentials.credentials.roomId
  }
  if (s.onlineSince) state.onlineSince = s.onlineSince
  if (s.nextAttemptAt) state.nextAttemptAt = s.nextAttemptAt
  return state
}

export const AUDIT_VIEW_SIZE = 200

/**
 * The audit log view: one row per command (a write-ahead `started` entry is replaced by its
 * outcome), the last `limit`, newest first. Device ids become names; results are left out.
 */
export function projectAudit(entries: readonly AuditEntry[], devices: readonly Pick<DeviceRecord, 'id' | 'name'>[], limit = AUDIT_VIEW_SIZE): RemoteAuditEntry[] {
  const names = new Map(devices.map((d) => [d.id, d.name]))
  const rows = new Map<string, RemoteAuditEntry>()
  for (const e of entries) {
    if (typeof e?.id !== 'string' || typeof e.deviceId !== 'string') continue
    const key = `${e.deviceId}\u0000${e.id}`
    const row: RemoteAuditEntry = {
      ts: typeof e.ts === 'string' ? e.ts : '',
      deviceId: e.deviceId,
      device: names.get(e.deviceId) ?? 'Removed phone',
      command: typeof e.name === 'string' ? e.name.slice(0, 64) : 'unknown',
      outcome: 'started' in e && e.started ? 'started' : 'ok' in e && e.ok ? 'ok' : 'failed'
    }
    if ('error' in e && e.error && typeof e.error.code === 'string') {
      row.error = `${e.error.code}${typeof e.error.message === 'string' ? `: ${e.error.message.slice(0, 200)}` : ''}`
    }
    // The outcome keeps the time the command arrived.
    const started = rows.get(key)
    if (started && row.outcome !== 'started' && started.outcome === 'started') row.ts = started.ts || row.ts
    rows.delete(key)
    rows.set(key, row)
  }
  return [...rows.values()].slice(-limit).reverse()
}
