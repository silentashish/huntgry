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
  /**
   * Pairing (#37): a frame no paired device's key opens is offered to the open pairing secrets;
   * `true` when one of them took it (it acks the frame itself).
   */
  pairing?: { receive(frame: RelayFrame): Promise<boolean> }
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
      // `attempt` is not reset here: a relay that opens and then refuses the owner keeps backing off.
      this.setState({ connection: 'online', onlineSince: new Date(this.now()).toISOString() })
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.deps.heartbeatMs ?? 30_000)
      this.heartbeatTimer.unref?.()
    })
    socket.on('message', (text) => {
      if (!live()) return
      // A failure here leaves the frame unacked at the relay, which redelivers it.
      this.receive(text).catch((err) => console.error('[remote] frame not processed; left for redelivery:', err))
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
      // Only a session that stayed up past the auth grace counts as a success that restarts the backoff.
      if (this.state.connection === 'online' && !refused) this.attempt = 0
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
      if (this.deps.pairing && (await this.deps.pairing.receive(frame))) return
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
    if (envelope.kind !== 'cmd') {
      await this.admitted(device, envelope, frame.ref)
      return
    }
    switch (envelope.kind) {
      case 'cmd': {
        // handle() resolves after the audit entry and the lastSeq checkpoint are on disk; a crash
        // before that rejects or never resolves, so the frame stays at the relay for redelivery.
        const reply = await this.deps.gateway.handle(device, envelope)
        // The relay deletes by the frame's ref (= Envelope.id for a well-formed phone).
        await this.send(device, { ...reply.result, ack: frame.ref })
        return
      }
    }
  }

  /**
   * hello / ping / result / event / pong: admitted by the gateway first (pairing, freshness,
   * `seq`, checkpoint), so an old or replayed frame cannot rename the device or draw a status.
   * An exact redelivery is answered again without its side effects.
   */
  private async admitted(device: DeviceRecord, envelope: Envelope, ref: string): Promise<void> {
    const admission = await this.deps.gateway.admit(device, envelope)
    if (admission.status === 'rejected') {
      if (envelope.kind === 'hello' || envelope.kind === 'ping') {
        await this.send(device, { kind: 'result', re: ref, ok: false, error: admission.error, body: null, ttl: 60, ack: ref })
      } else {
        await this.sendAck(ref)
      }
      return
    }
    const fresh = admission.status === 'new'
    switch (envelope.kind) {
      case 'hello':
        await this.answerHello(admission.device, envelope, ref, fresh)
        return
      case 'ping':
        await this.send(admission.device, { kind: 'pong', body: null, ttl: 60, ack: ref })
        return
      default:
        // Results, events and pongs from a phone: nothing to do (the desktop sends no commands),
        // nothing to reply with, so the ack goes alone once the checkpoint is on disk.
        await this.sendAck(ref)
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

  private async answerHello(device: DeviceRecord, envelope: Envelope, ref: string, fresh: boolean): Promise<void> {
    let hello: HelloBody
    try {
      hello = requireHelloBody(envelope.body)
      negotiateProtocol(hello.protocol)
    } catch (err) {
      const error = errorOf(err)
      await this.send(device, { kind: 'result', re: ref, ok: false, error, body: null, ttl: 60, ack: ref })
      return
    }
    if (fresh && hello.name !== device.name) await this.deps.devices.update(device.id, { name: hello.name.slice(0, 200) })
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
    await this.sendEvent(device, name, body, pushText)
  }

  private async sendEvent<N extends RemoteEventName>(device: DeviceRecord, name: N, body: RemoteEventBody<N>, pushText?: string, key?: Uint8Array): Promise<void> {
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
    await this.send(device, out, key)
  }

  /**
   * Tells a phone it was revoked (best effort). Takes the record the caller captured, because
   * the caller removes the device from the store first; the session key is derived from it.
   */
  async notifyRevoked(device: DeviceRecord, reason: string): Promise<void> {
    if (!this.isOnline()) return
    const key = await this.deps.devices.sessionKeyFor(device)
    if (!key) return
    await this.sendEvent(device, 'device.revoked', { reason: reason.slice(0, LIMITS.shortStringChars) }, undefined, key)
  }

  /** `{ ack: ref }` alone, in order with the other sends (pairing frames). */
  ack(ref: string): Promise<void> {
    return this.sendAck(ref)
  }

  /**
   * A frame built elsewhere (the pairing answers, sealed by `sealPairReply`), queued behind
   * earlier sends; resolves `false` when it could not be written (offline).
   */
  sendFrame(frame: RelayFrame): Promise<boolean> {
    let sent = false
    const task = async () => {
      const socket = this.socket
      if (!socket || !this.isOnline()) return
      socket.send(JSON.stringify(requireRelayFrame(frame)))
      sent = true
    }
    this.sending = this.sending.then(task, task).catch((err) => console.error('[remote] send failed:', err))
    return this.sending.then(() => sent)
  }

  /**
   * `{ ack: ref }` for a frame durably processed with nothing to send back (`RelayClientFrame`),
   * queued behind earlier sends. Dropped while offline: the relay redelivers and the gateway
   * answers the redelivery from its audit log.
   */
  private sendAck(ref: string): Promise<void> {
    const task = async () => {
      const socket = this.socket
      if (socket && this.isOnline()) this.writeAck(socket, ref)
    }
    this.sending = this.sending.then(task, task).catch((err) => console.error('[remote] ack failed:', err))
    return this.sending
  }

  private writeAck(socket: SocketLike, ref: string): void {
    if (this.socket !== socket) return
    socket.send(JSON.stringify(requireRelayClientFrame({ ack: ref })))
  }

  /**
   * Reserves the next `seq` (persisted first), boxes the envelope and sends the relay frame; in
   * order per session. When the frame carries an `ack` but cannot be sent (no session key, over
   * the budget), the ack still goes alone so the processed frame does not come back.
   */
  private send(device: DeviceRecord, out: Outgoing, givenKey?: Uint8Array): Promise<void> {
    const task = async () => {
      const socket = this.socket
      if (!socket || !this.isOnline()) return
      const ackAlone = () => {
        if (out.ack !== undefined) this.writeAck(socket, out.ack)
      }
      const key = givenKey ?? (await this.deps.devices.sessionKey(device.id))
      if (!key) return ackAlone()
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
          return ackAlone()
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
      try {
        requireRelayFrame(frame)
      } catch (err) {
        console.error(`[remote] ${out.kind} ${out.name ?? ''} is not a valid relay frame; not sent:`, (err as Error).message)
        return ackAlone()
      }
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
