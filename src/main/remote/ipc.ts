import { app, ipcMain, powerMonitor, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { AGENT_IDS, type AgentStatus } from '@shared/runner-types'
import { REMOTE_CHANNELS, type RemoteApi, type RemoteState } from '@shared/remote-types'
import { RELAY_PATHS, requireCreateRoomResponse } from '@shared/remote'
import { resolveApplicationFile } from '../applications/safe-path'
import { adapterFor } from '../cli/agents'
import { skillStatus } from '../cli/agents/skills'
import { findClaude, findCli, findSkillDir } from '../cli/env'
import { runsForRemote } from '../cli/ipc'
import { defaultAgent } from '../cli/start'
import { requireCurrentWorkspace, settingsFile } from '../current-workspace'
import { emit, onEvent } from '../events'
import { loadAndExtract } from '../jobs/loader'
import { addByUrl, listJobs } from '../jobs/service'
import { pipelineForRemote } from '../pipeline/ipc'
import { queueForRemote } from '../queue/ipc'
import { loadSettings, saveSettings } from '../workspace'
import { CredentialStore, newOwnerSecret, normalizeRelayUrl, relayRequest, type Cipher, type CredentialsRead, type RelayCredentials } from './credentials'
import { DeviceStore } from './devices'
import { RemoteEvents } from './events'
import { Gateway, statusOf, type GatewayServices } from './gateway'
import { revokeDevice } from './revoke'
import { RoomControl } from './rooms'
import { RemoteSession, type SocketLike } from './session'
import { workspaceIdentity } from './workspace'

/**
 * Wires the remote session into the app (ADR-0001, E3): `safeStorage` as the cipher,
 * `userData/remote/` for the credentials, the desktop key and the device checkpoint, the
 * gateway onto the queue, runs, jobs and application files, `onEvent` for the events every
 * window gets, `powerMonitor` for reconnects after sleep, and the `RemoteApi` for Settings.
 * Pairing (QR, approve) is #37; this file only hosts the session.
 */

const remoteDir = (): string => join(app.getPath('userData'), 'remote')

const cipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (blob) => safeStorage.decryptString(blob)
}

/** Node's WebSocket (undici) behind the small interface the session uses. */
function connect(url: string): SocketLike {
  const ws = new WebSocket(url)
  return {
    send: (text) => ws.send(text),
    close: () => ws.close(),
    on: (event: string, cb: (...args: never[]) => void) => {
      const f = cb as (...args: unknown[]) => void
      if (event === 'open') ws.addEventListener('open', () => f())
      else if (event === 'message') ws.addEventListener('message', (e) => f(typeof e.data === 'string' ? e.data : String(e.data)))
      else if (event === 'close') ws.addEventListener('close', (e) => f(e.reason || (e.code ? `code ${e.code}` : undefined)))
      else if (event === 'error') ws.addEventListener('error', () => f(new Error('WebSocket error')))
    }
  } as SocketLike
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

let devices: DeviceStore
let credentials: CredentialStore
let gateway: Gateway
let session: RemoteSession
let lastCredentials: CredentialsRead = { status: 'none' }
let agentsCache: { at: number; agents: Pick<AgentStatus, 'id' | 'ready'>[] } | null = null

async function remoteSettings(): Promise<{ enabled: boolean; notificationDetails: boolean; transcripts: boolean }> {
  const s = (await loadSettings(settingsFile())).remote ?? {}
  return { enabled: s.enabled === true, notificationDetails: s.notificationDetails === true, transcripts: s.transcripts !== false }
}

/** Which agents could run a job right now: CLI found and skill visible (no preflight; cached a minute). */
async function agentsReady(): Promise<Pick<AgentStatus, 'id' | 'ready'>[]> {
  if (agentsCache && Date.now() - agentsCache.at < 60_000) return agentsCache.agents
  const home = homedir()
  const agents = await Promise.all(
    AGENT_IDS.map(async (id) => {
      const [cli, skill] = await Promise.all([id === 'claude' ? findClaude() : findCli(adapterFor(id).binary), id === 'claude' ? findSkillDir() : skillStatus(id, home).then((s) => s.path)])
      return { id, ready: !!cli && !!skill }
    })
  )
  agentsCache = { at: Date.now(), agents }
  return agents
}

async function currentState(): Promise<RemoteState> {
  const settings = await remoteSettings()
  const s = session.current()
  const state: RemoteState = {
    connection: !settings.enabled ? 'disabled' : lastCredentials.status === 'unreadable' ? 'credentials-unreadable' : lastCredentials.status === 'none' ? 'unconfigured' : s.connection,
    notificationDetails: settings.notificationDetails,
    transcripts: settings.transcripts,
    devices: devices.list().map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, needsRepair: d.needsRepair, categories: d.categories }))
  }
  if (lastCredentials.status === 'unreadable') state.error = lastCredentials.error
  else if (rooms.revokeWarning()) state.error = rooms.revokeWarning()!
  else if (s.error && settings.enabled) state.error = s.error
  if (lastCredentials.status === 'ok') {
    state.relayUrl = lastCredentials.credentials.relayUrl
    state.roomId = lastCredentials.credentials.roomId
  }
  if (s.onlineSince) state.onlineSince = s.onlineSince
  if (s.nextAttemptAt) state.nextAttemptAt = s.nextAttemptAt
  return state
}

async function publish(): Promise<RemoteState> {
  const state = await currentState()
  emit('remote:state', state)
  return state
}

/** Applies the saved settings: connect when enabled and credentials are readable, else stay closed. */
async function apply(): Promise<RemoteState> {
  const settings = await remoteSettings()
  lastCredentials = await credentials.read()
  if (settings.enabled && lastCredentials.status === 'ok') session.start(lastCredentials.credentials)
  else session.stop()
  return publish()
}

async function relayCall(creds: Pick<RelayCredentials, 'relayUrl'>, path: string, token: string, method: 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const { url, init } = relayRequest(creds.relayUrl, path, token, method, body)
  // Never wait on the relay without a deadline (revocation and rotation must not hang on it).
  const res = await fetch(url, { ...init, signal: signal ?? AbortSignal.timeout(RELAY_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`The relay answered ${res.status} for ${method} ${path}.`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Mints a new owner secret and room (a rotation then deletes the old room; every phone pairs again). */
async function createRoom(relayUrl: string, adminToken: string): Promise<RelayCredentials> {
  const ownerSecret = newOwnerSecret()
  const created = requireCreateRoomResponse(await relayCall({ relayUrl }, RELAY_PATHS.rooms, adminToken, 'POST', { ownerSecretHash: sha256(ownerSecret) }))
  return { relayUrl, adminToken, roomId: created.roomId, ownerSecret }
}

/** Deletes a replaced room, best effort (rooms.ts calls it once the new credentials are saved). */
async function deleteRoom(old: RelayCredentials): Promise<void> {
  await relayCall(old, RELAY_PATHS.room(old.roomId), old.ownerSecret, 'DELETE').catch((err) => console.warn('[remote] deleting the old room failed:', err))
}

const RELAY_TIMEOUT_MS = 10_000

/** Rotate / Unpair everything, and the warning an unconfirmed relay revocation leaves until one runs. */
const rooms = new RoomControl({
  createRoom,
  deleteRoom,
  writeCredentials: (c) => credentials.write(c),
  rotateKeyPair: () => devices.rotateKeyPair(),
  stopSession: () => session.stop(),
  apply
})

/** Removes the device here first, then tells the phone and the relay with a deadline (see revoke.ts). */
async function revoke(id: string, reason: string): Promise<void> {
  const creds = lastCredentials.status === 'ok' ? lastCredentials.credentials : null
  const outcome = await revokeDevice(
    {
      devices,
      notify: (record, why) => session.notifyRevoked(record, why),
      relayDelete: async (deviceId, signal) => {
        if (!creds) return
        await relayCall(creds, RELAY_PATHS.device(creds.roomId, deviceId), creds.ownerSecret, 'DELETE', undefined, signal)
      },
      timeoutMs: RELAY_TIMEOUT_MS
    },
    id,
    reason
  )
  if (outcome.removed && !outcome.relayRevoked) {
    rooms.relayDidNotConfirmRevoke()
  }
}

const api: RemoteApi = {
  state: () => currentState(),
  setEnabled: async (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid value.')
    const current = (await loadSettings(settingsFile())).remote ?? {}
    await saveSettings(settingsFile(), { remote: { ...current, enabled } })
    return apply()
  },
  configure: async (input) => {
    const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
    const relayUrl = normalizeRelayUrl(p.relayUrl)
    if (typeof p.adminToken !== 'string' || !p.adminToken.trim() || p.adminToken.length > 512) throw new Error('Enter the relay admin token.')
    const previous = lastCredentials.status === 'ok' ? lastCredentials.credentials : null
    await rooms.replaceRoom(relayUrl, p.adminToken.trim(), previous)
    const current = (await loadSettings(settingsFile())).remote ?? {}
    await saveSettings(settingsFile(), { remote: { ...current, enabled: true } })
    return apply()
  },
  setNotificationDetails: async (on) => {
    const current = (await loadSettings(settingsFile())).remote ?? {}
    await saveSettings(settingsFile(), { remote: { ...current, notificationDetails: on === true } })
    return publish()
  },
  setTranscripts: async (on) => {
    const current = (await loadSettings(settingsFile())).remote ?? {}
    await saveSettings(settingsFile(), { remote: { ...current, transcripts: on !== false } })
    return publish()
  },
  revoke: async (deviceId) => {
    if (typeof deviceId !== 'string' || !devices.get(deviceId)) throw new Error('Unknown device.')
    await revoke(deviceId, 'This phone was removed in Settings.')
    return publish()
  },
  unpairAll: async () => {
    await Promise.all(devices.list().map((d) => revoke(d.id, 'All phones were unpaired in Settings.')))
    // Reconnects whatever the relay answers; a refused new room is thrown to Settings after that.
    await rooms.rotateAll(lastCredentials.status === 'ok' ? lastCredentials.credentials : null)
    return currentState()
  }
}

let starting: Promise<void> | null = null

/**
 * Creates the stores, the gateway and the session, subscribes to events and connects when
 * enabled. Never rejects: a failure is logged and Settings reports it on its next call.
 */
export function startRemote(): Promise<void> {
  starting ??= init().catch((err: unknown) => console.error('[remote] could not start the remote session:', err))
  return starting
}

/** Settings may call before `startRemote` finished (or after it failed). */
async function started(): Promise<RemoteApi> {
  await startRemote()
  if (!session) throw new Error('Remote control could not start. Restart Huntgry and check the logs.')
  return api
}

async function init(): Promise<void> {
  devices = new DeviceStore(remoteDir(), cipher)
  credentials = new CredentialStore(remoteDir(), cipher)
  await devices.load()
  const services: GatewayServices = {
    desktopName: hostname().replace(/\.local$/, '') || 'Huntgry',
    appVersion: app.getVersion(),
    workspace: async () => workspaceIdentity((await requireCurrentWorkspace()).path),
    agents: agentsReady,
    defaultAgent,
    queue: queueForRemote,
    runs: runsForRemote,
    jobs: { list: listJobs, addUrl: (ws, url) => addByUrl(ws, url, loadAndExtract) },
    files: { resolve: resolveApplicationFile },
    pipeline: pipelineForRemote,
    transcripts: () => transcriptsOn
  }
  gateway = new Gateway(services, devices)
  const status = async () => statusOf(services, await services.workspace())
  session = new RemoteSession({
    connect,
    devices,
    gateway,
    desktopName: services.desktopName,
    appVersion: services.appVersion,
    workspace: () => services.workspace().catch(() => null),
    status,
    notificationDetails: () => detailsOn,
    onState: () => void publish().catch((err: unknown) => console.error('[remote] publishing the state failed:', err))
  })
  const events = new RemoteEvents({ broadcast: (name, body, pushText, hint) => session.broadcast(name, body, pushText, hint), status })
  onEvent((channel, payload) => {
    if (!session.isOnline()) return
    void events.handle(channel, payload)
  })
  powerMonitor.on('resume', () => session.reconnectNow())
  powerMonitor.on('unlock-screen', () => session.reconnectNow())
  await refreshToggles()
  await apply()
}

let detailsOn = false
let transcriptsOn = true

async function refreshToggles(): Promise<void> {
  const s = await remoteSettings()
  detailsOn = s.notificationDetails
  transcriptsOn = s.transcripts
}

/** Closes the session (quit). */
export async function stopRemote(): Promise<void> {
  session?.stop()
  await devices?.flush()
}

export function registerRemoteIpc(): void {
  ipcMain.handle(REMOTE_CHANNELS.state, async () => (await started()).state())
  ipcMain.handle(REMOTE_CHANNELS.setEnabled, async (_e, enabled: unknown) => (await started()).setEnabled(enabled as boolean))
  ipcMain.handle(REMOTE_CHANNELS.configure, async (_e, input: unknown) => (await started()).configure(input as { relayUrl: string; adminToken: string }))
  ipcMain.handle(REMOTE_CHANNELS.setNotificationDetails, async (_e, on: unknown) => {
    const state = await (await started()).setNotificationDetails(on === true)
    await refreshToggles()
    return state
  })
  ipcMain.handle(REMOTE_CHANNELS.setTranscripts, async (_e, on: unknown) => {
    const state = await (await started()).setTranscripts(on !== false)
    await refreshToggles()
    return state
  })
  ipcMain.handle(REMOTE_CHANNELS.revoke, async (_e, id: unknown) => (await started()).revoke(id as string))
  ipcMain.handle(REMOTE_CHANNELS.unpairAll, async () => (await started()).unpairAll())
}
