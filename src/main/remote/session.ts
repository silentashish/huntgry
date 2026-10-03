import { randomUUID } from 'node:crypto'
import {
  LIMITS,
  PROTOCOL,
  ProtocolError,
  RELAY_PATHS,
  errorOf,
  negotiateProtocol,
  openEnvelope,
  requireEnvelope,
  requireEvent,
  requireHelloBody,
  requireRelayClientFrame,
  requireRelayFrame,
  requireRelayNotice,
  sealEnvelope,
  type Envelope,
  type HelloBody,
  type NotificationCategory,
  type RelayFrame,
  type RemoteEventBody,
  type RemoteEventName,
  type StatusSummary
} from '@shared/remote'
import type { RelayCredentials } from './credentials'
import { socketUrl } from './credentials'
import type { DeviceRecord, DeviceStore } from './devices'
import { categoryOf, type Gateway } from './gateway'
import type { WorkspaceIdentity } from './workspace'

/**
 * The desktop's session with the relay (ADR-0001, "Architecture", "Security model"): one
 * **outbound** `wss` socket, authenticated with the owner secret in its first frame, then
 * `nacl.box` frames per paired device with a fresh nonce each, `seq` persisted before every
 * send, heartbeat `status` events, and a backoff reconnect on close, error and wake.
 * The socket is injected (`connect`), so tests run against an in-process fake relay.
 */

export interface SocketLike {
  send(text: string): void
  close(): void
  on(event: 'open', cb: () => void): void
  on(event: 'message', cb: (text: string) => void): void
  on(event: 'close', cb: (reason?: string) => void): void
  on(event: 'error', cb: (err: Error) => void): void
}

export type Connect = (url: string) => SocketLike

export interface SessionState {
  connection: 'offline' | 'connecting' | 'online'
  error?: string
  onlineSince?: string
  nextAttemptAt?: string
}

export interface SessionDeps {
  connect: Connect
  devices: DeviceStore
  gateway: Gateway
  desktopName: string
  appVersion: string
  workspace(): Promise<WorkspaceIdentity | null>
  /** The current status, for `hello` replies and heartbeats. */
  status(): Promise<StatusSummary>
  /** "Show details in notifications" (default off). */
  notificationDetails(): boolean
  onState?(state: SessionState): void
  now?(): number
  /** Defaults: 30 s heartbeat to devices active in the last 5 min; backoff 1 s … 60 s. */
  heartbeatMs?: number
  activeWindowMs?: number
  backoffMinMs?: number
  backoffMaxMs?: number
  /** Seconds a result or event may wait at the relay (the command's own ttl for results). */
  eventTtl?: number
}

interface Outgoing {
  kind: Envelope['kind']
  id?: string
  re?: string
  name?: string
  ok?: boolean
  error?: Envelope['error']
  body: unknown
  ttl: number
  ack?: string
  pushHint?: NotificationCategory
  pushText?: string
}

const AUTH_GRACE_MS = 5_000

export class RemoteSession {
  private socket: SocketLike | null = null
  private credentials: RelayCredentials | null = null
  private stopped = true
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private openedAt = 0
  private state: SessionState = { connection: 'offline' }
  /** Sends are serialised so `seq` leaves in order. */
  private sending: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(private deps: SessionDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  current(): SessionState {
    return { ...this.state }
  }

  isOnline(): boolean {
    return this.state.connection === 'online'
  }

  /** Opens (or re-opens) the session with these credentials. */
  start(credentials: RelayCredentials): void {
    this.credentials = credentials
    this.stopped = false
    this.attempt = 0
    this.disconnect()
    this.connect()
  }

  /** Closes the socket and stops reconnecting (quit, disable, rotation). */
  stop(): void {
    this.stopped = true
    this.disconnect()
    this.setState({ connection: 'offline' })
  }

  /** Wake from sleep or network back: reconnect now instead of waiting out the backoff. */
  reconnectNow(): void {
    if (this.stopped || !this.credentials) return
    this.attempt = 0
    this.disconnect()
    this.connect()
  }

  private setState(next: SessionState): void {
    this.state = next
    this.deps.onState?.({ ...next })
  }

  private disconnect(): void {
    this.generation++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    const s = this.socket
    this.socket = null
    if (s) {
      try {
        s.close()
      } catch {
        // already closed
      }
    }
  }

  private connect(): void {
    if (this.stopped || !this.credentials || this.socket) return
    const gen = ++this.generation
    const { relayUrl, roomId, ownerSecret } = this.credentials
    this.setState({ connection: 'connecting' })
    let socket: SocketLike
    try {
      socket = this.deps.connect(socketUrl(relayUrl, RELAY_PATHS.socket))
    } catch (err) {
      this.scheduleReconnect(`Could not open the relay socket: ${(err as Error).message}`)
      return
    }
    this.socket = socket
    const live = () => gen === this.generation && this.socket === socket
    socket.on('open', () => {
      if (!live()) return
      this.openedAt = this.now()
      // Credentials go in the first frame, never in the URL (ADR "Relay authentication").
      const auth = requireRelayClientFrame({ auth: { room: roomId, owner: ownerSecret } })
      socket.send(JSON.stringify(auth))
      this.attempt = 0
      this.setState({ connection: 'online', onlineSince: new Date(this.now()).toISOString() })
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.deps.heartbeatMs ?? 30_000)
      this.heartbeatTimer.unref?.()
    })
    socket.on('message', (text) => {
      if (!live()) return
      void this.receive(text)
    })
    socket.on('error', (err) => {
      if (!live()) return
      this.state.error = err.message
    })
    socket.on('close', (reason) => {
      if (!live()) return
      this.socket = null
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      const refused = this.state.connection === 'online' && this.now() - this.openedAt < AUTH_GRACE_MS
      this.scheduleReconnect(refused ? `The relay closed the session right after authentication${reason ? ` (${reason})` : ''}; check the credentials.` : (reason ?? this.state.error ?? 'The relay connection closed.'))
    })
  }

  private scheduleReconnect(error: string): void {
    if (this.stopped) return
    const min = this.deps.backoffMinMs ?? 1_000
    const max = this.deps.backoffMaxMs ?? 60_000
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 10)) * (0.8 + Math.random() * 0.4)
    this.attempt++
    const at = new Date(this.now() + delay).toISOString()
    this.setState({ connection: 'offline', error, nextAttemptAt: at })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  // ── incoming ────────────────────────────────────────────────────────────────────────────

  private async receive(text: string): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    if (!('ct' in raw)) {
      try {
        const notice = requireRelayNotice(raw)
        if ('presence' in notice) return
        if ('tooLarge' in notice) console.warn(`[remote] relay refused frame ${notice.ref}: ${notice.bytes} bytes`)
      } catch {
        // Unknown clear frame: ignore.
      }
      return
    }
    let frame: RelayFrame
    try {
      frame = requireRelayFrame(raw)
    } catch (err) {
      console.warn('[remote] malformed relay frame:', (err as Error).message)
      return
    }
    // The frame does not say which phone sent it; only the right session key opens the box (Poly1305).
    const opened = await this.open(frame)
    if (!opened) {
      console.warn(`[remote] frame ${frame.ref} opened with no paired device's key; dropped`)
      return
    }
    const { device, plain } = opened
    let envelope: Envelope
    try {
      envelope = requireEnvelope(plain, { sid: device.sid, from: 'phone' })
    } catch (err) {
      const error = errorOf(err)
      await this.deps.gateway.recordRejected(device, frame.ref, error)
      await this.send(device, { kind: 'result', re: frame.ref, ok: false, error, body: null, ttl: this.deps.eventTtl ?? 24 * 60 * 60, ack: frame.ref })
      return
    }
    await this.deps.devices.update(device.id, { lastSeen: new Date(this.now()).toISOString() })
    switch (envelope.kind) {
      case 'cmd': {
        const reply = await this.deps.gateway.handle(device, envelope)
        await this.send(device, { ...reply.result, ack: reply.ack })
        return
      }
      case 'hello':
        await this.answerHello(device, envelope, frame.ref)
        return
      case 'ping':
        await this.send(device, { kind: 'pong', body: null, ttl: 60, ack: frame.ref })
        return
      default:
        // Results, events and pongs from a phone: nothing to do (the desktop sends no commands).
        return
    }
  }

  private async open(frame: RelayFrame): Promise<{ device: DeviceRecord; plain: unknown } | null> {
    for (const device of this.deps.devices.list()) {
      const key = await this.deps.devices.sessionKey(device.id)
      if (!key) continue
      const plain = openEnvelope(frame, key)
      if (plain !== null) return { device, plain }
    }
    return null
  }

  private async answerHello(device: DeviceRecord, envelope: Envelope, ref: string): Promise<void> {
    let hello: HelloBody
    try {
      hello = requireHelloBody(envelope.body)
      negotiateProtocol(hello.protocol)
    } catch (err) {
      const error = errorOf(err)
      await this.send(device, { kind: 'result', re: ref, ok: false, error, body: null, ttl: 60, ack: ref })
      return
    }
    if (hello.name !== device.name) await this.deps.devices.update(device.id, { name: hello.name.slice(0, 200) })
    const workspace = await this.deps.workspace().catch(() => null)
    const body: HelloBody = { protocol: { ...PROTOCOL }, name: this.deps.desktopName, appVersion: this.deps.appVersion }
    if (workspace) body.workspace = { id: workspace.id, name: workspace.name }
    await this.send(device, { kind: 'hello', body, ttl: 60, ack: ref })
    const status = await this.deps.status().catch(() => null)
    if (status) await this.sendEventTo(device.id, 'status', status)
  }

  // ── outgoing ────────────────────────────────────────────────────────────────────────────

  /** A heartbeat `status` to every device that talked recently (others get it on their next `hello`). */
  private async heartbeat(): Promise<void> {
    if (!this.isOnline()) return
    const window = this.deps.activeWindowMs ?? 5 * 60_000
    const active = this.deps.devices.active().filter((d) => d.lastSeen && this.now() - Date.parse(d.lastSeen) < window)
    if (active.length === 0) return
    const status = await this.deps.status().catch(() => null)
    if (!status) return
    for (const d of active) await this.sendEventTo(d.id, 'status', status)
  }

  /**
   * An event to every paired device, with `pushHint` only for devices that asked for its
   * category and `pushText` only when the owner enabled details. Dropped while offline.
   */
  async broadcast<N extends RemoteEventName>(name: N, body: RemoteEventBody<N>, pushText?: string): Promise<void> {
    if (!this.isOnline()) return
    for (const d of this.deps.devices.active()) await this.sendEventTo(d.id, name, body, pushText)
  }

  async sendEventTo<N extends RemoteEventName>(deviceId: string, name: N, body: RemoteEventBody<N>, pushText?: string): Promise<void> {
    const device = this.deps.devices.get(deviceId)
    if (!device || device.needsRepair) return
    let event
    try {
      event = requireEvent(name, body)
    } catch (err) {
      console.error(`[remote] event ${name} failed its own guard; not sent:`, (err as Error).message)
      return
    }
    const out: Outgoing = { kind: 'event', name: event.name, body: event.body, ttl: this.deps.eventTtl ?? 24 * 60 * 60 }
    if (name === 'status') out.ttl = 60
    const category = categoryOf(event)
    if (category && device.categories.includes(category)) {
      out.pushHint = category
      if (pushText && this.deps.notificationDetails()) out.pushText = [...pushText].slice(0, LIMITS.pushTextChars).join('')
    }
    await this.send(device, out)
  }

  /** Tells a phone it was revoked (best effort; the caller deletes the device afterwards). */
  async notifyRevoked(deviceId: string, reason: string): Promise<void> {
    if (!this.isOnline()) return
    await this.sendEventTo(deviceId, 'device.revoked', { reason: reason.slice(0, LIMITS.shortStringChars) })
  }

  /** Reserves the next `seq` (persisted first), boxes the envelope and sends the relay frame; in order per session. */
  private send(device: DeviceRecord, out: Outgoing): Promise<void> {
    const task = async () => {
      const socket = this.socket
      if (!socket || !this.isOnline()) return
      const key = await this.deps.devices.sessionKey(device.id)
      if (!key) return
      const { seq, persisted } = this.deps.devices.nextOutSeq()
      await persisted
      const envelope: Envelope = {
        v: 1,
        sid: device.sid,
        from: 'desktop',
        seq,
        ts: new Date(this.now()).toISOString(),
        ttl: out.ttl,
        kind: out.kind,
        id: out.id ?? randomUUID(),
        body: out.body
      }
      if (out.re !== undefined) envelope.re = out.re
      if (out.name !== undefined) envelope.name = out.name
      if (out.ok !== undefined) envelope.ok = out.ok
      if (out.error !== undefined) envelope.error = out.error
      try {
        requireEnvelope(envelope)
      } catch (err) {
        if (out.kind !== 'result') {
          console.error(`[remote] ${out.kind} ${out.name ?? ''} exceeds the frame budget; not sent`)
          return
        }
        // A result too large for one frame: the phone gets a failure instead of nothing.
        envelope.ok = false
        envelope.body = null
        envelope.error = errorOf(err instanceof ProtocolError ? new ProtocolError('failed', 'The result is too large to send to the phone.') : err)
      }
      const frame: RelayFrame = { to: device.id, ref: envelope.id!, ...sealEnvelope(envelope, key), ttl: out.ttl }
      if (out.ack !== undefined) frame.ack = out.ack
      if (out.pushHint !== undefined) frame.pushHint = out.pushHint
      if (out.pushText !== undefined) frame.pushText = out.pushText
      requireRelayFrame(frame)
      if (this.socket !== socket) return
      socket.send(JSON.stringify(frame))
    }
    this.sending = this.sending.then(task, task).catch((err) => console.error('[remote] send failed:', err))
    return this.sending
  }

  /** Resolves once queued sends are done (tests). */
  flush(): Promise<void> {
    return this.sending
  }
}
