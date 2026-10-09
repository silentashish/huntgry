import { app, ipcMain, powerMonitor, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { AGENT_IDS, type AgentStatus } from '@shared/runner-types'
import { REMOTE_CHANNELS, type RemoteApi, type RemoteCommandTtl, type RemoteState } from '@shared/remote-types'
import { COMMAND_TTL_SECONDS, RELAY_PATHS, requireCreateRoomResponse } from '@shared/remote'
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
import { AuditLog } from './audit'
import { CredentialStore, newOwnerSecret, relayRequest, type Cipher, type CredentialsRead, type RelayCredentials } from './credentials'
import { DeviceStore } from './devices'
import { Gateway, type GatewayServices } from './gateway'
import { PairingManager } from './pairing'
import { projectQueue, projectRun, projectStatus } from './project'
import { revokeDevice } from './revoke'
import { RoomControl } from './rooms'
import { RemoteSession, type SocketLike } from './session'
import { readRemoteSettings, updateRemoteSettings, type RemoteSettings } from './settings'
import { AUDIT_VIEW_SIZE, buildRemoteState, projectAudit } from './state'
import { requireBoolean, requireCommandTtlInput, requireConfigureInput, requireRemoteId } from './validate'
import { workspaceIdentity } from './workspace'

/**
 * Wires the remote session into the app (ADR-0001, E3): `safeStorage` as the cipher,
 * `userData/remote/` for the credentials, the desktop key and the device checkpoint, the
 * gateway onto the queue, runs, jobs and application files, `onEvent` for the events every
 * window gets, `powerMonitor` for reconnects after sleep, pairing (#37, `pairing.ts`) onto the
 * session and the relay, and the `RemoteApi` for Settings (arguments checked in `validate.ts`,
 * answers built in `state.ts`).
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
let pairing: PairingManager
let lastCredentials: CredentialsRead = { status: 'none' }
let agentsCache: { at: number; agents: Pick<AgentStatus, 'id' | 'ready'>[] } | null = null

const remoteSettings = (): Promise<RemoteSettings> => readRemoteSettings(settingsFile())

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
  return buildRemoteState({
    settings: await remoteSettings(),
    credentials: lastCredentials,
    session: session.current(),
    revokeWarning: rooms.revokeWarning(),
    devices: devices.list(),
    pairings: pairing.list()
  })
}

async function publish(): Promise<RemoteState> {
  const state = await currentState()
  emit('remote:state', state)
  return state
}

const publishLater = (): void => void publish().catch((err: unknown) => console.error('[remote] publishing the state failed:', err))

/** Applies the saved settings: connect when enabled and credentials are readable, else stay closed. */
async function apply(): Promise<RemoteState> {
  const settings = await remoteSettings()
  lastCredentials = await credentials.read()
  if (settings.enabled && lastCredentials.status === 'ok') session.start(lastCredentials.credentials)
  else session.stop()
  return publish()
}

/** A relay answer other than 2xx; `status` lets a revocation treat 404 (no such token) as done. */
class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string
  ) {
    super(`The relay answered ${status} for ${method} ${path}.`)
  }
}

async function relayCall(creds: Pick<RelayCredentials, 'relayUrl'>, path: string, token: string, method: 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const { url, init } = relayRequest(creds.relayUrl, path, token, method, body)
  // Never wait on the relay without a deadline (revocation and rotation must not hang on it).
  const res = await fetch(url, { ...init, signal: signal ?? AbortSignal.timeout(RELAY_TIMEOUT_MS) })
  if (!res.ok) throw new RelayHttpError(res.status, method, path)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** The saved credentials, or an error for Settings. */
function savedCredentials(): RelayCredentials {
  if (lastCredentials.status === 'ok') return lastCredentials.credentials
  throw new Error(lastCredentials.status === 'unreadable' ? 'The relay credentials are unreadable. Enter the relay URL and admin token again to recover.' : 'Set up the relay first.')
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
  markAllNeedsRepair: () => devices.markAllNeedsRepair(),
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
        try {
          await relayCall(creds, RELAY_PATHS.device(creds.roomId, deviceId), creds.ownerSecret, 'DELETE', undefined, signal)
        } catch (err) {
          // 404: this room holds no such token (a phone left from a rotated room): nothing to revoke.
          if (!(err instanceof RelayHttpError && err.status === 404)) throw err
        }
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
    await updateRemoteSettings(settingsFile(), { enabled: requireBoolean(enabled) })
    if (!enabled) pairing.cancelAll()
    return apply()
  },
  configure: async (input) => {
    const { relayUrl, adminToken } = requireConfigureInput(input)
    const previous = lastCredentials.status === 'ok' ? lastCredentials.credentials : null
    const replacing = previous !== null || lastCredentials.status === 'unreadable'
    // The only place a room is created: once on the first Save, again only when the owner replaces it.
    await rooms.replaceRoom(relayUrl, adminToken, previous, replacing)
    if (replacing) pairing.cancelAll()
    await updateRemoteSettings(settingsFile(), { enabled: true })
    return apply()
  },
  rotate: async () => {
    const current = savedCredentials()
    await rooms.replaceRoom(current.relayUrl, current.adminToken, current)
    pairing.cancelAll()
    return apply()
  },
  setNotificationDetails: async (on) => {
    await updateRemoteSettings(settingsFile(), { notificationDetails: requireBoolean(on) })
    await refreshToggles()
    return publish()
  },
  setTranscripts: async (on) => {
    await updateRemoteSettings(settingsFile(), { transcripts: requireBoolean(on) })
    await refreshToggles()
    return publish()
  },
  setCommandTtl: async (input) => {
    await updateRemoteSettings(settingsFile(), { commandTtl: requireCommandTtlInput(input) })
    await refreshToggles()
    return publish()
  },
  revoke: async (deviceId) => {
    const id = requireRemoteId(deviceId, 'device')
    if (!devices.get(id)) throw new Error('Unknown device.')
    await revoke(id, 'This phone was removed in Settings.')
    return publish()
  },
  unpairAll: async () => {
    pairing.cancelAll()
    await Promise.all(devices.list().map((d) => revoke(d.id, 'All phones were unpaired in Settings.')))
    // Reconnects whatever the relay answers; a refused new room is thrown to Settings after that.
    await rooms.rotateAll(lastCredentials.status === 'ok' ? lastCredentials.credentials : null)
    return currentState()
  },
  startPairing: async () => {
    if (!(await remoteSettings()).enabled) throw new Error('Turn on remote control first.')
    savedCredentials()
    return pairing.start()
  },
  cancelPairing: async (pairingId) => {
    pairing.cancel(requireRemoteId(pairingId, 'pairing'))
    return currentState()
  },
  approvePairing: async (pairingId) => {
    await pairing.approve(requireRemoteId(pairingId, 'pairing'))
    return publish()
  },
  denyPairing: async (pairingId) => {
    await pairing.deny(requireRemoteId(pairingId, 'pairing'))
    return publish()
  },
  audit: async () => {
    const workspace = await requireCurrentWorkspace().catch(() => null)
    if (!workspace) return []
    // Twice the view: a write-ahead entry and its outcome are two lines of one command.
    const entries = await AuditLog.forWorkspace(workspace.path).entries(AUDIT_VIEW_SIZE * 2)
    return projectAudit(entries, devices.list())
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
    transcripts: () => transcriptsOn,
    commandTtl: () => commandTtl
  }
  gateway = new Gateway(services, devices)
  const status = async () => {
    const workspace = await services.workspace()
    return projectStatus({ desktopName: services.desktopName, appVersion: services.appVersion, workspace, queue: await queueForRemote.state(workspace.path), agents: await agentsReady() })
  }
  session = new RemoteSession({
    connect,
    devices,
    gateway,
    desktopName: services.desktopName,
    appVersion: services.appVersion,
    workspace: () => services.workspace().catch(() => null),
    status,
    notificationDetails: () => detailsOn,
    pairing: { receive: (frame) => pairing.receive(frame) },
    onState: publishLater
  })
  pairing = new PairingManager({
    devices,
    relay: () => (lastCredentials.status === 'ok' ? { relayUrl: lastCredentials.credentials.relayUrl, roomId: lastCredentials.credentials.roomId } : null),
    registerPairing: async (pairingId, exp) => {
      const c = savedCredentials()
      await relayCall(c, RELAY_PATHS.pairings(c.roomId), c.ownerSecret, 'POST', { pairingId, exp })
    },
    registerDevice: async (deviceId, tokenHash) => {
      const c = savedCredentials()
      await relayCall(c, RELAY_PATHS.devices(c.roomId), c.ownerSecret, 'POST', { deviceId, tokenHash })
    },
    unregisterDevice: async (deviceId) => {
      const c = savedCredentials()
      await relayCall(c, RELAY_PATHS.device(c.roomId, deviceId), c.ownerSecret, 'DELETE')
    },
    send: (frame) => session.sendFrame(frame),
    ack: (ref) => session.ack(ref),
    online: () => session.isOnline(),
    desktopName: services.desktopName,
    onChange: publishLater
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
let commandTtl: { costly: number; default: number } = { ...COMMAND_TTL_SECONDS }

/** The gateway and the session read these synchronously on every frame. */
async function refreshToggles(): Promise<void> {
  const s = await remoteSettings()
  detailsOn = s.notificationDetails
  transcriptsOn = s.transcripts
  commandTtl = { ...s.commandTtl }
}

/** Closes the session (quit). */
export async function stopRemote(): Promise<void> {
  session?.stop()
  await devices?.flush()
}

export function registerRemoteIpc(): void {
  // Every argument arrives as `unknown` and is checked by the API itself (validate.ts).
  const handle = (channel: string, call: (api: RemoteApi, arg: unknown) => Promise<unknown>) => ipcMain.handle(channel, async (_e, arg: unknown) => call(await started(), arg))
  handle(REMOTE_CHANNELS.state, (a) => a.state())
  handle(REMOTE_CHANNELS.setEnabled, (a, v) => a.setEnabled(v as boolean))
  handle(REMOTE_CHANNELS.configure, (a, v) => a.configure(v as { relayUrl: string; adminToken: string }))
  handle(REMOTE_CHANNELS.rotate, (a) => a.rotate())
  handle(REMOTE_CHANNELS.setNotificationDetails, (a, v) => a.setNotificationDetails(v as boolean))
  handle(REMOTE_CHANNELS.setTranscripts, (a, v) => a.setTranscripts(v as boolean))
  handle(REMOTE_CHANNELS.setCommandTtl, (a, v) => a.setCommandTtl(v as RemoteCommandTtl))
  handle(REMOTE_CHANNELS.revoke, (a, v) => a.revoke(v as string))
  handle(REMOTE_CHANNELS.unpairAll, (a) => a.unpairAll())
  handle(REMOTE_CHANNELS.startPairing, (a) => a.startPairing())
  handle(REMOTE_CHANNELS.cancelPairing, (a, v) => a.cancelPairing(v as string))
  handle(REMOTE_CHANNELS.approvePairing, (a, v) => a.approvePairing(v as string))
  handle(REMOTE_CHANNELS.denyPairing, (a, v) => a.denyPairing(v as string))
  handle(REMOTE_CHANNELS.audit, (a) => a.audit())
}
