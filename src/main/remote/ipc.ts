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
import { queueForRemote } from '../queue/ipc'
import { loadSettings, saveSettings } from '../workspace'
import { CredentialStore, newOwnerSecret, normalizeRelayUrl, relayRequest, type Cipher, type CredentialsRead, type RelayCredentials } from './credentials'
import { DeviceStore } from './devices'
import { Gateway, type GatewayServices } from './gateway'
import { projectQueue, projectRun, projectStatus } from './project'
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

async function relayCall(creds: Pick<RelayCredentials, 'relayUrl'>, path: string, token: string, method: 'POST' | 'DELETE', body?: unknown): Promise<unknown> {
  const { url, init } = relayRequest(creds.relayUrl, path, token, method, body)
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`The relay answered ${res.status} for ${method} ${path}.`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Mints a new owner secret and room (rotation deletes the old room; every phone pairs again). */
async function createRoom(relayUrl: string, adminToken: string, previous: RelayCredentials | null): Promise<RelayCredentials> {
  const ownerSecret = newOwnerSecret()
  const created = requireCreateRoomResponse(await relayCall({ relayUrl }, RELAY_PATHS.rooms, adminToken, 'POST', { ownerSecretHash: sha256(ownerSecret) }))
  if (previous) {
    await relayCall(previous, RELAY_PATHS.room(previous.roomId), previous.ownerSecret, 'DELETE').catch((err) => console.warn('[remote] deleting the old room failed:', err))
  }
  return { relayUrl, adminToken, roomId: created.roomId, ownerSecret }
}

async function revokeDevice(id: string, reason: string): Promise<void> {
  await session.notifyRevoked(id, reason)
  if (lastCredentials.status === 'ok') {
    const c = lastCredentials.credentials
    await relayCall(c, RELAY_PATHS.device(c.roomId, id), c.ownerSecret, 'DELETE').catch((err) => console.warn('[remote] revoking on the relay failed:', err))
  }
  await devices.remove(id)
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
    const next = await createRoom(relayUrl, p.adminToken.trim(), previous)
    await credentials.write(next)
    if (previous) await devices.rotateKeyPair()
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
    await revokeDevice(deviceId, 'This phone was removed in Settings.')
    return publish()
  },
  unpairAll: async () => {
    for (const d of devices.list()) await revokeDevice(d.id, 'All phones were unpaired in Settings.')
    await devices.rotateKeyPair()
    if (lastCredentials.status === 'ok') {
      const c = lastCredentials.credentials
      session.stop()
      await credentials.write(await createRoom(c.relayUrl, c.adminToken, c))
    }
    return apply()
  }
}

/** Creates the stores, the gateway and the session, subscribes to events and connects when enabled. */
export async function startRemote(): Promise<void> {
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
    transcripts: () => transcriptsOn
  }
  gateway = new Gateway(services, devices)
  const status = async () => projectStatus({ desktopName: services.desktopName, appVersion: services.appVersion, workspace: await services.workspace(), queue: await queueForRemote.state(), agents: await agentsReady() })
  session = new RemoteSession({
    connect,
    devices,
    gateway,
    desktopName: services.desktopName,
    appVersion: services.appVersion,
    workspace: () => services.workspace().catch(() => null),
    status,
    notificationDetails: () => detailsOn,
    onState: () => void publish()
  })
  onEvent((channel, payload) => {
    if (!session.isOnline()) return
    if (channel === 'queue:changed') {
      const state = payload as Parameters<typeof projectQueue>[0]
      void session.broadcast('queue.changed', projectQueue(state))
      void status().then((s) => session.broadcast('status', s)).catch(() => undefined)
    } else if (channel === 'runner:run') {
      const run = payload as Parameters<typeof projectRun>[0]
      void session.broadcast('run.changed', projectRun(run), run.title)
    } else if (channel === 'applications:changed') {
      void session.broadcast('applications.changed', { ids: [] })
    }
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
  ipcMain.handle(REMOTE_CHANNELS.state, () => api.state())
  ipcMain.handle(REMOTE_CHANNELS.setEnabled, (_e, enabled: unknown) => api.setEnabled(enabled as boolean))
  ipcMain.handle(REMOTE_CHANNELS.configure, (_e, input: unknown) => api.configure(input as { relayUrl: string; adminToken: string }))
  ipcMain.handle(REMOTE_CHANNELS.setNotificationDetails, async (_e, on: unknown) => {
    const state = await api.setNotificationDetails(on === true)
    await refreshToggles()
    return state
  })
  ipcMain.handle(REMOTE_CHANNELS.setTranscripts, async (_e, on: unknown) => {
    const state = await api.setTranscripts(on !== false)
    await refreshToggles()
    return state
  })
  ipcMain.handle(REMOTE_CHANNELS.revoke, (_e, id: unknown) => api.revoke(id as string))
  ipcMain.handle(REMOTE_CHANNELS.unpairAll, () => api.unpairAll())
}
