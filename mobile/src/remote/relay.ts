/**
 * The phone's side of the relay socket (ADR-0001, "Transport"; #38):
 *
 * - **First-frame auth.** The socket URL is the bare `wss://…/ws`; the first frame is
 *   `{ auth: { room, device, token } }`. Credentials never go in the URL or a header.
 * - **Boxing.** Every frame is an `Envelope` sealed with the pairing's session key
 *   (`sealEnvelope` / `openEnvelope`) inside a `RelayFrame{ to: 'desktop', ref: id, ttl }`.
 * - **One counter.** `seq` comes from `Vault.nextSeq()`, persisted before the frame leaves; it
 *   is assigned at the moment of sending, in one serial loop, so frames reach the desktop in
 *   `seq` order. A frame that may not have reached the relay is retransmitted byte for byte
 *   (same `ref`, `seq`, ciphertext) before anything new after a reconnect: the relay drops a
 *   duplicate `ref`, the desktop answers a known id from its audit log.
 * - **Desktop `seq`.** Accepted when `seq > lastSeq` (gaps are normal: the desktop's counter
 *   is shared by every device), persisted after the frame is handled.
 * - **Acks.** `{ ack: ref }` once a result or event has been applied and stored, or piggybacked
 *   on the next outgoing frame; throttled with every other frame under the relay's 60 per
 *   minute. Duplicates (same `id`, or a result for the same `re`) are acked and dropped.
 * - **Relay notices.** presence, `queued` ("Will run when your Mac wakes"), `expired`
 *   ("Expired before your Mac woke up"), `tooLarge`.
 * - **Close codes.** 4001 revoked, 4002 unauthorized and 4004 room deleted end the pairing;
 *   4000 (replaced by another socket of this phone) waits for the app to come back; anything
 *   else reconnects with backoff (1 s … 60 s, jitter; 30 s at least after 1008).
 * - **Pair again.** A `denied` answer (rewound counter, device no longer paired) and
 *   `device.revoked` are fatal: the owner of this client wipes the vault.
 * - **Push token (#39).** The clear frame `{ pushToken }` goes out after every authentication
 *   (the relay keeps it per device; one frame per connection keeps it right after a relay
 *   restore or a token change) and again whenever it changes; `{ pushToken: null }` when the
 *   owner turns push off, unpairs (`farewell`) or the pairing ends while the socket is open. The
 *   token never goes inside an `Envelope`: the desktop never sees it.
 */

import {
  PROTOCOL,
  openEnvelope,
  requireEnvelope,
  requireEvent,
  requireFresh,
  requireRelayClientFrame,
  requireRelayFrame,
  requireRelayNotice,
  sealEnvelope,
  fromBase64,
  RELAY_PATHS,
  type Envelope,
  type EnvelopeError,
  type HelloBody,
  type RelayFrame,
  type RelayNotice
} from '@huntgry/remote-protocol'
import { deliveryFromNotice, envelopeFor, needsWorkspace, NoWorkspaceError, type Command, type DeliveryState } from './commands'
import { socketUrl, uuid } from './ids'
import { SOCKET_OPEN, systemClock, type Clock, type SocketFactory, type SocketLike } from './platform'
import type { Pairing, Vault } from './vault'

export type ConnectionState = 'connecting' | 'online' | 'retrying' | 'replaced' | 'stopped'

/** Why the pairing is over; the app wipes the vault and shows Pair (again). */
export type FatalReason = 'denied' | 'revoked' | 'unauthorized' | 'room-deleted'

export const CLOSE_CODES = {
  replaced: 4000,
  revoked: 4001,
  unauthorized: 4002,
  authTimeout: 4003,
  roomDeleted: 4004,
  heartbeatMissed: 4005,
  pairingExpired: 4006,
  policy: 1008,
  tooBig: 1009
} as const

export interface SentCommand {
  id: string
  command: Command
  seq: number
  /** The exact serialised `RelayFrame` (without a piggybacked ack), for retransmission. */
  frame: string
  /** ms since epoch when it expires at the relay. */
  expiresAt: number
  state: DeliveryState
}

/**
 * Thrown by `onEnvelope` when the phone could not store what the frame carried (the secure
 * store refused a write). The frame stays unacked and unchecked so the relay delivers it again.
 */
export class StorageError extends Error {
  constructor(message = 'The phone could not store this.') {
    super(message)
    this.name = 'StorageError'
  }
}

export interface RelayClientEvents {
  onState?(state: ConnectionState, detail: { retryInMs?: number; code?: number }): void
  /** Presence and every other clear notice from the relay. */
  onNotice?(notice: RelayNotice): void
  /** A command moved to `queued`, `expired`, `too-large`, `done` or `failed`. */
  onDelivery?(id: string, state: DeliveryState, error?: EnvelopeError): void
  /**
   * A fresh desktop envelope (`hello`, `result`, `event`, `pong`), after the session, `seq`,
   * freshness and duplicate checks. The frame is acked once this resolves; a `StorageError`
   * leaves it unacked for redelivery, any other rejection is a body the screens refuse.
   */
  onEnvelope(envelope: Envelope, sent: SentCommand | undefined): Promise<void> | void
  /** The pairing is over: wipe and pair again. */
  onFatal(reason: FatalReason, message: string): Promise<void> | void
}

export interface RelayClientOptions {
  pairing: Pairing
  vault: Vault
  socket: SocketFactory
  appVersion: string
  /** The open workspace id (from the last `StatusSummary` or the desktop's `hello`). */
  workspaceId: () => string | null
  events: RelayClientEvents
  clock?: Clock
  random?: () => number
  backoffMinMs?: number
  backoffMaxMs?: number
  /** A `ping` keeps the desktop's 30 s `status` heartbeat coming (it only feeds devices seen in the last 5 min). */
  pingEveryMs?: number
  /** No frame within this long after a ping: the socket is presumed dead and replaced. */
  pingTimeoutMs?: number
  /** Frames per rolling minute this client sends (the relay closes at 60 with 1008). */
  frameBudget?: number
  /** Of that budget, how many acks may use (the rest stays free for the owner's commands). */
  ackBudget?: number
}

const WINDOW_MS = 60_000
const SESSION_TTL_SECONDS = 60
const SEEN_LIMIT = 1000

type OutItem = { kind: 'cmd'; id: string; command: Command } | { kind: 'hello' } | { kind: 'ping' } | { kind: 'push' }

/** `undefined`: the phone has no opinion yet (push never asked for), nothing is sent. */
export type PushTokenState = string | null | undefined

export class RelayClient {
  private socket: SocketLike | null = null
  private authed = false
  private stopped = true
  private attempt = 0
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  private watchdog: unknown = null
  private pumpTimer: unknown = null
  private connectTimer: unknown = null
  private pumping = false
  private pumpAgain = false
  private state: ConnectionState = 'stopped'
  private readonly outbox: OutItem[] = []
  private retransmit: SentCommand[] = []
  private readonly acks: string[] = []
  private readonly sent = new Map<string, SentCommand>()
  private readonly seen = new Set<string>()
  private readonly sendTimes: number[] = []
  private inbound: Promise<void> = Promise.resolve()
  private readonly clock: Clock
  private readonly sessionKey: Uint8Array
  private pairing: Pairing
  private pushToken: PushTokenState = undefined
  /** What this socket last told the relay (reset on every connection). */
  private pushSent: PushTokenState = undefined
  private authWaiters: (() => void)[] = []

  constructor(private readonly o: RelayClientOptions) {
    this.clock = o.clock ?? systemClock
    this.pairing = o.pairing
    this.sessionKey = fromBase64(o.pairing.sessionKey)
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  /** Closes the socket and stops reconnecting. Unsent commands stay in memory. */
  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.detach(1000, 'stopped')
    this.setState('stopped', {})
  }

  /**
   * The app went to the background: acks out, socket closed (1000), no reconnect until `wake()`.
   * The relay pushes only to a phone without a live socket, and iOS suspends an app without
   * closing its socket, so a suspended phone would otherwise miss its pushes (#39). Unsent and
   * unanswered commands stay in memory and go out after `wake()`.
   */
  sleep(): void {
    if (this.stopped) return
    // Between reconnect attempts there is no socket, only a retry timer: cancel it too, or it
    // reconnects in the background and the relay stops pushing.
    if (!this.socket && this.retryTimer === null) return
    this.flushAcksNow()
    this.clearTimers()
    this.detach(1000, 'background')
    this.setState('stopped', {})
  }

  /** App back in the foreground, network back: reconnect now instead of waiting out the backoff. */
  wake(): void {
    if (this.stopped) return
    if (this.socket && this.authed) {
      this.enqueuePing()
      return
    }
    if (this.socket) return
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    this.connect()
  }

  /**
   * The Expo push token the relay should use for this phone, or `null` to remove it. Sent now
   * when the socket is up and differs from what it last sent, and after every authentication.
   * A token the relay would refuse (it closes the socket with 1008) is not sent.
   */
  setPushToken(token: PushTokenState): void {
    if (token !== undefined && token !== null) {
      try {
        requireRelayClientFrame({ pushToken: token })
      } catch {
        return
      }
    }
    this.pushToken = token
    this.queuePushToken()
  }

  /**
   * Unpair: tells the relay to forget the push token (`{ pushToken: null }`), then stops. Waits
   * up to `timeoutMs` for a socket when there is none right now; without one the token stays
   * at the relay until the Mac revokes this phone (the owner is told to do that anyway).
   */
  async farewell(timeoutMs = 4_000): Promise<boolean> {
    this.pushToken = null
    let sent = false
    if (!this.stopped) {
      if (!this.authed) {
        this.wake()
        await this.waitForAuth(timeoutMs)
      }
      const socket = this.socket
      // The authentication itself may have sent it already (the send loop runs on auth).
      if (socket && this.authed) sent = this.pushSent === null || this.write(socket, JSON.stringify(requireRelayClientFrame({ pushToken: null })))
    }
    this.stop()
    return sent
  }

  private waitForAuth(timeoutMs: number): Promise<void> {
    if (this.authed) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(done, timeoutMs)
      const self = this
      function done() {
        self.clock.clearTimeout(timer)
        self.authWaiters = self.authWaiters.filter((w) => w !== done)
        resolve()
      }
      this.authWaiters.push(done)
    })
  }

  private queuePushToken(): void {
    if (!this.authed || this.pushToken === undefined || this.pushToken === this.pushSent) return
    if (!this.outbox.some((o) => o.kind === 'push')) this.outbox.push({ kind: 'push' })
    this.pump()
  }

  /** The device name sent in the next `hello`. */
  setPairing(pairing: Pairing): void {
    this.pairing = pairing
  }

  get connection(): ConnectionState {
    return this.state
  }

  /** Commands sent and not answered yet. */
  pending(): SentCommand[] {
    return [...this.sent.values()]
  }

  /**
   * Queues a validated command and returns its id (= `Envelope.id` = `RelayFrame.ref`); the
   * result arrives through `onEnvelope` with `re` = this id. Throws `NoWorkspaceError` when the
   * command needs a workspace id the phone does not know yet.
   */
  send(command: Command): string {
    if (needsWorkspace(command.name) && !this.o.workspaceId()) throw new NoWorkspaceError()
    const id = uuid()
    this.outbox.push({ kind: 'cmd', id, command })
    this.pump()
    return id
  }

  // ── socket ───────────────────────────────────────────────────────────────────────────

  private connect(): void {
    this.retryTimer = null
    this.setState('connecting', {})
    let socket: SocketLike
    try {
      socket = this.o.socket(socketUrl(this.pairing.relay, RELAY_PATHS.socket))
    } catch {
      this.scheduleRetry(0)
      return
    }
    this.socket = socket
    this.authed = false
    this.pushSent = undefined
    socket.onopen = () => {
      if (this.socket !== socket) return
      const auth = requireRelayClientFrame({ auth: { room: this.pairing.room, device: this.pairing.deviceId, token: this.pairing.relayToken } })
      this.write(socket, JSON.stringify(auth))
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.onMessage(event.data)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.onClose(event.code)
    }
    socket.onerror = () => undefined
    // The relay closes an unauthenticated socket after 5 s; this catches a socket that never opens.
    this.connectTimer = this.clock.setTimeout(() => {
      this.connectTimer = null
      if (this.socket === socket && !this.authed) this.drop(1006)
    }, 15_000)
  }

  private write(socket: SocketLike, text: string): boolean {
    if (socket.readyState !== SOCKET_OPEN) return false
    socket.send(text)
    this.sendTimes.push(this.clock.now())
    return true
  }

  /** Forgets the socket without waiting for its close event, then reconnects. */
  private drop(code: number): void {
    this.detach(1000, 'reconnecting')
    this.onClose(code)
  }

  private detach(code: number, reason: string): void {
    const socket = this.socket
    this.socket = null
    this.authed = false
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close(code, reason)
    } catch {
      // already closed
    }
  }

  private onClose(code: number): void {
    this.socket = null
    this.authed = false
    this.clearSessionTimers()
    if (this.stopped) return
    switch (code) {
      case CLOSE_CODES.revoked:
        void this.fatal('revoked', 'This phone was unpaired on your Mac.')
        return
      case CLOSE_CODES.unauthorized:
        void this.fatal('unauthorized', 'The relay no longer knows this phone. Pair it again.')
        return
      case CLOSE_CODES.roomDeleted:
        void this.fatal('room-deleted', 'Your Mac reset its relay. Pair this phone again.')
        return
      case CLOSE_CODES.replaced:
        // Another socket of this phone took over: do not fight it; wake() reconnects.
        this.setState('replaced', { code })
        return
      default:
        this.scheduleRetry(code)
    }
  }

  private scheduleRetry(code: number): void {
    const min = this.o.backoffMinMs ?? 1_000
    const max = this.o.backoffMaxMs ?? 60_000
    let delay = Math.min(max, min * 2 ** this.attempt)
    delay = Math.round(delay * (0.8 + 0.4 * (this.o.random ?? Math.random)()))
    // After the jitter, so it cannot pull the wait below the floor.
    if (code === CLOSE_CODES.policy) delay = Math.max(delay, Math.min(max, 30_000)) // rate limited: let the minute pass
    this.attempt++
    this.setState('retrying', { retryInMs: delay, code })
    this.retryTimer = this.clock.setTimeout(() => this.connect(), delay)
  }

  private async fatal(reason: FatalReason, message: string): Promise<void> {
    // Still connected (a `denied` answer, `device.revoked`): the relay may keep this device's
    // row until the Mac revokes it, so the push token goes first.
    const socket = this.socket
    if (socket && this.authed && this.pushSent) this.write(socket, JSON.stringify({ pushToken: null }))
    this.stopped = true
    this.clearTimers()
    this.detach(1000, reason)
    this.outbox.length = 0
    this.retransmit = []
    this.sent.clear()
    this.setState('stopped', {})
    await this.o.events.onFatal(reason, message)
  }

  private setState(state: ConnectionState, detail: { retryInMs?: number; code?: number }): void {
    this.state = state
    this.o.events.onState?.(state, detail)
  }

  // ── incoming ─────────────────────────────────────────────────────────────────────────

  private onMessage(data: unknown): void {
    if (this.watchdog !== null) {
      this.clock.clearTimeout(this.watchdog)
      this.watchdog = null
    }
    if (typeof data !== 'string') return
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    if (!('ct' in raw)) {
      let notice: RelayNotice
      try {
        notice = requireRelayNotice(raw)
      } catch {
        return // a clear frame this build does not know
      }
      this.onNotice(notice)
      return
    }
    let frame: RelayFrame
    try {
      frame = requireRelayFrame(raw)
    } catch {
      return
    }
    // One frame at a time: lastSeq only moves forward and acks follow the order of arrival.
    this.inbound = this.inbound.then(() => this.receive(frame)).catch(() => undefined)
  }

  private onNotice(notice: RelayNotice): void {
    if ('presence' in notice && !this.authed) {
      // The relay answers a valid auth frame with presence first.
      this.authed = true
      this.attempt = 0
      if (this.connectTimer !== null) this.clock.clearTimeout(this.connectTimer)
      this.connectTimer = null
      this.setState('online', {})
      this.onAuthed()
      for (const waiter of [...this.authWaiters]) waiter()
    }
    const delivery = deliveryFromNotice(notice)
    const sent = delivery ? this.sent.get(delivery.ref) : undefined
    if (delivery && sent) {
      // Queued at the relay: stored there, so it is not retransmitted. Expired / too large: gone.
      if (delivery.state === 'queued') sent.state = 'queued'
      else this.sent.delete(sent.id)
      this.o.events.onDelivery?.(sent.id, delivery.state)
    }
    this.o.events.onNotice?.(notice)
  }

  private dedupeKey(env: Envelope): string {
    return env.kind === 'result' ? `re:${env.re}` : `id:${env.id ?? `${env.kind}:${env.seq}`}`
  }

  private remember(key: string): void {
    this.seen.add(key)
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string)
  }

  private async receive(frame: RelayFrame): Promise<void> {
    if (this.stopped) return
    const plain = openEnvelope(frame, this.sessionKey)
    // Not for this session key: leave it unacked (the relay expires it), exactly like the desktop.
    if (plain === null) return
    let env: Envelope
    try {
      env = requireEnvelope(plain, { sid: this.pairing.sid, from: 'desktop' })
      requireFresh(env, this.clock.now())
    } catch {
      // Malformed, another session, or older than its ttl: it will not get better.
      this.ack(frame.ref)
      return
    }
    const key = this.dedupeKey(env)
    if (this.seen.has(key) || env.seq <= this.o.vault.desktopLastSeq) {
      this.ack(frame.ref)
      return
    }
    const sent = env.kind === 'result' && env.re !== undefined ? this.sent.get(env.re) : undefined

    if (env.kind === 'result' && env.ok === false && env.error?.code === 'denied') {
      const name = sent?.command.name ?? ''
      // A review answers `denied` for a revision it never showed (#42); everything else means "pair again".
      if (!name.startsWith('review.')) {
        this.ack(frame.ref)
        this.flushAcksNow()
        await this.fatal('denied', env.error.message)
        return
      }
    }
    if (env.kind === 'event' && env.name === 'device.revoked') {
      this.ack(frame.ref)
      this.flushAcksNow()
      await this.fatal('revoked', 'This phone was unpaired on your Mac.')
      return
    }
    if (env.kind === 'event') {
      try {
        requireEvent(env.name, env.body)
      } catch {
        // An event this build does not know (`unsupported`) or a body over its bounds.
        await this.o.vault.acceptDesktopSeq(env.seq)
        this.remember(key)
        this.ack(frame.ref)
        return
      }
    }
    try {
      await this.o.events.onEnvelope(env, sent)
    } catch (err) {
      // Not stored: no checkpoint, no ack, so the relay delivers it again.
      if (err instanceof StorageError) return
      // A body the screens refuse is not retried by the relay either.
    }
    if (env.kind === 'result' && env.re !== undefined) {
      if (this.sent.delete(env.re)) this.o.events.onDelivery?.(env.re, env.ok ? 'done' : 'failed', env.error)
    }
    // Stored, then acked: a crash before this line gets the frame redelivered.
    await this.o.vault.acceptDesktopSeq(env.seq)
    this.remember(key)
    this.ack(frame.ref)
  }

  // ── outgoing ─────────────────────────────────────────────────────────────────────────

  private onAuthed(): void {
    const now = this.clock.now()
    // Frames that may not have reached the relay, in seq order, before anything new.
    this.retransmit = [...this.sent.values()]
      .filter((s) => s.state !== 'queued')
      .sort((a, b) => a.seq - b.seq)
      .filter((s) => {
        if (s.expiresAt > now) return true
        this.sent.delete(s.id)
        this.o.events.onDelivery?.(s.id, 'expired')
        return false
      })
    this.outbox.unshift({ kind: 'hello' })
    // ADR "Pairing", step 12: `{ pushToken }` right after auth, before anything boxed.
    if (this.pushToken !== undefined && !this.outbox.some((o) => o.kind === 'push')) this.outbox.unshift({ kind: 'push' })
    this.schedulePing()
    this.pump()
  }

  private schedulePing(): void {
    if (this.pingTimer !== null) this.clock.clearTimeout(this.pingTimer)
    this.pingTimer = this.clock.setTimeout(() => {
      this.pingTimer = null
      this.enqueuePing()
      this.schedulePing()
    }, this.o.pingEveryMs ?? 120_000)
  }

  private enqueuePing(): void {
    if (!this.authed) return
    if (!this.outbox.some((o) => o.kind === 'ping')) this.outbox.push({ kind: 'ping' })
    this.pump()
  }

  private ack(ref: string): void {
    if (!this.acks.includes(ref)) this.acks.push(ref)
    this.pump()
  }

  /** Before a fatal close: the acks go out if the budget allows, so the relay does not redeliver. */
  private flushAcksNow(): void {
    const socket = this.socket
    if (!socket || !this.authed) return
    while (this.acks.length > 0 && this.budgetLeft() > 0) this.write(socket, JSON.stringify({ ack: this.acks.shift()! }))
  }

  private budgetLeft(forAck = false): number {
    const now = this.clock.now()
    while (this.sendTimes.length > 0 && this.sendTimes[0] <= now - WINDOW_MS) this.sendTimes.shift()
    const limit = forAck ? (this.o.ackBudget ?? 40) : (this.o.frameBudget ?? 50)
    return limit - this.sendTimes.length
  }

  private waitForBudget(): void {
    if (this.pumpTimer !== null) return
    const oldest = this.sendTimes[0] ?? this.clock.now()
    const wait = Math.max(50, oldest + WINDOW_MS - this.clock.now() + 10)
    this.pumpTimer = this.clock.setTimeout(() => {
      this.pumpTimer = null
      this.pump()
    }, wait)
  }

  /** One serial loop: seq assignment, sealing and sending happen in order, never concurrently. */
  private pump(): void {
    if (this.pumping) {
      // A drain is finishing (its end runs a microtask later): run again after it, or this call is lost.
      this.pumpAgain = true
      return
    }
    this.pumping = true
    this.pumpAgain = false
    void this.drain().finally(() => {
      this.pumping = false
      if (this.pumpAgain) this.pump()
    })
  }

  private async drain(): Promise<void> {
    for (;;) {
      const socket = this.socket
      if (!socket || !this.authed || this.stopped) return
      const resend = this.retransmit[0]
      if (resend) {
        if (this.budgetLeft() <= 0) return this.waitForBudget()
        this.retransmit.shift()
        if (this.sent.has(resend.id)) this.write(socket, this.withAck(resend.frame))
        continue
      }
      const item = this.outbox[0]
      if (item) {
        if (this.budgetLeft() <= 0) return this.waitForBudget()
        this.outbox.shift()
        await this.sendItem(socket, item)
        continue
      }
      if (this.acks.length > 0) {
        if (this.budgetLeft(true) <= 0) return this.waitForBudget()
        this.write(socket, JSON.stringify(requireRelayClientFrame({ ack: this.acks.shift()! })))
        continue
      }
      return
    }
  }

  /** Adds the oldest pending ack to an outgoing frame (one frame, two jobs). */
  private withAck(frameText: string): string {
    const ack = this.acks.shift()
    if (ack === undefined) return frameText
    const frame = JSON.parse(frameText) as RelayFrame
    frame.ack = ack
    return JSON.stringify(frame)
  }

  private async sendItem(socket: SocketLike, item: OutItem): Promise<void> {
    if (item.kind === 'push') {
      // A clear frame: no envelope, no seq. Whatever the token is now (it may have changed while queued).
      const token = this.pushToken
      if (token === undefined || token === this.pushSent) return
      if (this.write(socket, JSON.stringify(requireRelayClientFrame({ pushToken: token })))) this.pushSent = token
      return
    }
    let seq: number
    try {
      seq = await this.o.vault.nextSeq()
    } catch {
      // The counter could not be persisted: nothing goes out under an unsaved number.
      if (item.kind === 'cmd') this.o.events.onDelivery?.(item.id, 'failed', { code: 'failed', message: 'The phone could not save its message counter.' })
      return
    }
    const now = this.clock.now()
    let env: Envelope
    try {
      if (item.kind === 'cmd') {
        env = envelopeFor({ command: item.command, id: item.id, sid: this.pairing.sid, seq, now, workspaceId: this.o.workspaceId() })
      } else {
        const body: HelloBody | null = item.kind === 'hello' ? { protocol: { ...PROTOCOL }, name: this.pairing.deviceName, appVersion: this.o.appVersion } : null
        env = { v: 1, sid: this.pairing.sid, from: 'phone', seq, ts: new Date(now).toISOString(), ttl: SESSION_TTL_SECONDS, kind: item.kind, id: uuid(), body }
      }
      requireEnvelope(env)
    } catch (err) {
      if (item.kind === 'cmd') this.o.events.onDelivery?.(item.id, 'failed', { code: 'invalid', message: (err as Error).message })
      return
    }
    const frame: RelayFrame = { to: 'desktop', ref: env.id!, ...sealEnvelope(env, this.sessionKey), ttl: env.ttl }
    try {
      requireRelayFrame(frame)
    } catch {
      if (item.kind === 'cmd') this.o.events.onDelivery?.(item.id, 'too-large')
      return
    }
    const text = JSON.stringify(frame)
    if (item.kind === 'cmd') {
      // Recorded before the socket sees it: if the socket died meanwhile, the reconnect resends it.
      this.sent.set(item.id, { id: item.id, command: item.command, seq, frame: text, expiresAt: now + env.ttl * 1000, state: 'sent' })
      this.o.events.onDelivery?.(item.id, 'sent')
    }
    if (this.socket !== socket || !this.write(socket, this.withAck(text))) return
    if (item.kind === 'ping') this.armWatchdog()
  }

  private armWatchdog(): void {
    if (this.watchdog !== null) this.clock.clearTimeout(this.watchdog)
    this.watchdog = this.clock.setTimeout(() => {
      this.watchdog = null
      // Nothing came back (no pong, no queued notice): a half-open socket after a network change.
      if (this.socket && this.authed) this.drop(1006)
    }, this.o.pingTimeoutMs ?? 20_000)
  }

  private clearSessionTimers(): void {
    for (const t of [this.pingTimer, this.watchdog, this.connectTimer, this.pumpTimer]) if (t !== null) this.clock.clearTimeout(t)
    this.pingTimer = null
    this.watchdog = null
    this.connectTimer = null
    this.pumpTimer = null
  }

  private clearTimers(): void {
    this.clearSessionTimers()
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}
