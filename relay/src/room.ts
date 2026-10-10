/**
 * One Durable Object per room (ADR-0001, "Architecture", "Delivery, acknowledgement and
 * idempotency", "Relay authentication and isolation").
 *
 * The room forwards and queues opaque ciphertext between one desktop and its paired phones.
 * It reads only the clear fields of a `RelayFrame` (`to`, `ref`, `ttl`, `ack`, `pushHint`,
 * `pushText`), never `ct`. Sockets use the WebSocket Hibernation API, so an idle room costs
 * nothing; everything a hibernated room needs to resume is in SQLite or in each socket's
 * serialised attachment.
 *
 * Tables
 *   meta      owner secret hash, presence timestamps
 *   pairings  pairing ids the desktop registered, with expiry
 *   devices   paired devices: relay token hash, Expo push token
 *   inbox     per-recipient queue: every frame gets a `seq` (the deliverySeq) on arrival and is
 *             deleted only by an ack of its `ref`, by its `ttl`, or by the 50-frame cap on phones
 *   notices   `{ expired, ref }` notices waiting for a sender that is not connected
 *   pushes    last push time per device and category (coalescing)
 *   receipts  Expo ticket ids of accepted pushes, until their receipt is read (DeviceNotRegistered)
 *   push_retries  one pending retry per device and category after a transient push failure (#70)
 */
import { DurableObject } from 'cloudflare:workers'
import {
  COMMAND_TTL_SECONDS,
  LIMITS,
  ProtocolError,
  requireCreateRoomRequest,
  requireRegisterDeviceRequest,
  requireRegisterPairingRequest,
  requireRelayClientFrame,
  requireRelayFrame,
  utf8Bytes,
  type NotificationCategory,
  type RelayClientFrame,
  type RelayFrame,
  type RelayNotice
} from '@huntgry/remote-protocol'
import { bearerOf, matchesHash } from './auth'
import { configOf, type Config, type Env } from './env'
import { EXPO_PUSH_TOKEN, PUSH_TIMEOUT_MS, RECEIPT_IDS_PER_CALL, RECEIPT_MAX_AGE_MS, fetchReceipts, pushMessage, sendExpoPush } from './push'
import { countFrame, type RateWindow } from './rate'

/** Frames the relay holds per phone; beyond it the oldest events go, results never (ADR). */
export const MAX_UNACKED_PER_PHONE = 50
/** Per-connection rate limit (ADR "Relay authentication and isolation"). */
export const FRAMES_PER_MINUTE = 60
/** A frame without `ttl` is held as long as a default command. */
export const DEFAULT_TTL_SECONDS = COMMAND_TTL_SECONDS.default
/** A pairing registration may not be valid for longer than this (the QR expires in 2 min). */
export const MAX_PAIRING_SECONDS = 10 * 60
/** Ticket ids waiting for their receipt, per room; the oldest go first beyond it. */
const MAX_PENDING_RECEIPTS = 1000
/** Expired notices kept per sender while it is away. */
const MAX_NOTICES_PER_OWNER = 100
/**
 * Push retries sent per alarm. One: the alarm also runs the auth deadlines and the heartbeat
 * check, so it never waits on more than one Expo request; the next due retry gets an alarm
 * right after (`scheduleAlarm` sees it due).
 */
const PUSH_RETRIES_PER_ALARM = 1
/** How long a due push retry is held while its request is out; well past `PUSH_TIMEOUT_MS`. */
const PUSH_RETRY_LEASE_MS = 4 * PUSH_TIMEOUT_MS

/** Close codes the relay uses; 1008 (policy violation) for protocol errors. */
export const CLOSE = {
  policy: 1008,
  replaced: 4000,
  revoked: 4001,
  unauthorized: 4002,
  authTimeout: 4003,
  roomDeleted: 4004,
  heartbeat: 4005,
  pairingExpired: 4006
} as const

export const DESKTOP = 'desktop'

/** Serialised with the socket so it survives hibernation; `rate` is the connection's frame window. */
type Attachment = ({ pending: true; deadline: number } | { pending: false; kind: 'desktop' | 'device' | 'pairing'; id: string }) & { rate?: RateWindow }
type SocketKind = Extract<Attachment, { pending: false }>['kind']

interface InboxRow extends Record<string, SqlStorageValue> {
  seq: number
  owner: string
  sender: string
  ref: string
  frame: string
  expires: number
  result: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, push_token TEXT, registered_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, sender TEXT NOT NULL, ref TEXT NOT NULL, frame TEXT NOT NULL, expires INTEGER NOT NULL, result INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS inbox_owner ON inbox (owner, seq);
CREATE INDEX IF NOT EXISTS inbox_expires ON inbox (expires);
CREATE TABLE IF NOT EXISTS notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, notice TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pushes (device TEXT NOT NULL, category TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (device, category));
CREATE TABLE IF NOT EXISTS receipts (ticket TEXT PRIMARY KEY, device TEXT NOT NULL, token TEXT NOT NULL, sent_at INTEGER NOT NULL, check_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS receipts_check ON receipts (check_at);
CREATE TABLE IF NOT EXISTS push_retries (device TEXT NOT NULL, category TEXT NOT NULL, token TEXT NOT NULL, text TEXT, attempt INTEGER NOT NULL, next_at INTEGER NOT NULL, PRIMARY KEY (device, category));
CREATE INDEX IF NOT EXISTS push_retries_next ON push_retries (next_at);
`

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

export class Room extends DurableObject<Env> {
  private readonly config: Config

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.config = configOf(env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA)
    })
  }

  // ── HTTP (from the Worker only; the public routes live in worker.ts) ─────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const now = Date.now()

    if (request.method === 'POST' && path === '/init') {
      if (this.meta('ownerHash')) return json({ error: 'room exists' }, 409)
      const body = await readBody(request, requireCreateRoomRequest)
      if ('error' in body) return body.error
      this.setMeta('ownerHash', body.ownerSecretHash)
      this.setMeta('createdAt', String(now))
      this.setMeta('desktopSince', new Date(now).toISOString())
      return json({ roomId: this.roomId() }, 201)
    }

    if (!this.meta('ownerHash')) return json({ error: 'no such room' }, 404)

    if (path === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket upgrade required' }, 426)
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      const attachment: Attachment = { pending: true, deadline: now + this.config.authTimeoutMs }
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment(attachment)
      await this.scheduleAlarm()
      return new Response(null, { status: 101, webSocket: client })
    }

    // Everything else is a desktop call authenticated with the owner secret.
    const secret = bearerOf(request)
    if (!secret || !(await matchesHash(secret, this.meta('ownerHash')))) return json({ error: 'unauthorized' }, 401)

    if (request.method === 'POST' && path === '/pairings') {
      const body = await readBody(request, requireRegisterPairingRequest)
      if ('error' in body) return body.error
      const { pairingId } = body
      const exp = Date.parse(body.exp)
      if (pairingId === DESKTOP) return json({ error: `pairingId "${DESKTOP}" is reserved` }, 400)
      if (exp <= now || exp > now + MAX_PAIRING_SECONDS * 1000) return json({ error: `exp must be within the next ${MAX_PAIRING_SECONDS} s` }, 400)
      this.sql('DELETE FROM pairings WHERE exp <= ?', now)
      this.sql('INSERT OR REPLACE INTO pairings (id, exp) VALUES (?, ?)', pairingId, exp)
      await this.scheduleAlarm()
      return json({ ok: true }, 201)
    }

    if (request.method === 'POST' && path === '/devices') {
      const body = await readBody(request, requireRegisterDeviceRequest)
      if ('error' in body) return body.error
      const { deviceId } = body
      if (deviceId === DESKTOP) return json({ error: `deviceId "${DESKTOP}" is reserved` }, 400)
      this.sql('INSERT INTO devices (id, token_hash, registered_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash', deviceId, body.tokenHash, now)
      // A new token invalidates the socket that authenticated with the old one.
      for (const ws of this.socketsOf('device', deviceId)) ws.close(CLOSE.revoked, 'token replaced')
      return json({ ok: true }, 201)
    }

    const revoke = request.method === 'DELETE' ? /^\/devices\/([^/]+)$/.exec(path) : null
    if (revoke) {
      const deviceId = decodeURIComponent(revoke[1])
      const existed = this.sql<{ id: string }>('SELECT id FROM devices WHERE id = ?', deviceId).length > 0
      this.revokeDevice(deviceId)
      await this.scheduleAlarm()
      return existed ? new Response(null, { status: 204 }) : json({ error: 'no such device' }, 404)
    }

    if (request.method === 'DELETE' && path === '/') {
      for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE.roomDeleted, 'room deleted')
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.ctx.storage.sql.exec(SCHEMA) // empty tables again: the object answers 404 until an /init
      return new Response(null, { status: 204 })
    }

    return json({ error: 'not found' }, 404)
  }

  // ── WebSocket (Hibernation API) ───────────────────────────────────────────────────────────

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return ws.close(CLOSE.policy, 'text frames only')
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) return ws.close(CLOSE.policy, 'no session')
    const rate = countFrame(attachment.rate, Date.now(), FRAMES_PER_MINUTE)
    if (!rate.ok) return ws.close(CLOSE.policy, 'rate limited')
    attachment.rate = rate.window
    ws.serializeAttachment(attachment)

    const bytes = utf8Bytes(message)
    let value: unknown
    try {
      value = JSON.parse(message)
    } catch {
      return ws.close(CLOSE.policy, 'not JSON')
    }

    if (attachment.pending) return this.authenticate(ws, value)

    if (bytes > LIMITS.frameBytes) {
      const ref = (value as { ref?: unknown } | null)?.ref
      this.notify(ws, { tooLarge: true, ref: typeof ref === 'string' && ref.length > 0 && ref.length <= LIMITS.idChars ? ref : '?', bytes })
      return
    }

    if (attachment.kind === 'desktop') await this.touchDesktop()

    try {
      if (isClientFrame(value)) await this.onClientFrame(ws, attachment, requireRelayClientFrame(value))
      else await this.onRelayFrame(ws, attachment, requireRelayFrame(value))
    } catch (e) {
      // The reason quotes the guard's message (field names and limits), never the frame.
      ws.close(CLOSE.policy, e instanceof ProtocolError ? e.message.slice(0, 120) : 'invalid frame')
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Complete the close handshake: the compatibility date predates web_socket_auto_reply_to_close.
    try {
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason)
    } catch {
      // already closed by us
    }
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (attachment && !attachment.pending && attachment.kind === 'desktop' && this.socketsOf('desktop', DESKTOP, ws).length === 0) {
      await this.desktopOffline()
    }
    await this.scheduleAlarm()
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'socket error')
  }

  override async alarm(): Promise<void> {
    const now = Date.now()

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.pending && attachment.deadline <= now) ws.close(CLOSE.authTimeout, 'authentication timeout')
    }

    const lastSeen = Number(this.meta('desktopLastSeen') ?? 0)
    if (now - lastSeen >= 2 * this.config.heartbeatMs) {
      const desktops = this.socketsOf('desktop', DESKTOP)
      if (desktops.length > 0) {
        for (const ws of desktops) ws.close(CLOSE.heartbeat, 'two heartbeats missed')
        await this.desktopOffline()
      }
    }

    this.expireFrames(now)
    // RegisterPairingRequest.exp: the relay closes pairing sockets after it.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment && !attachment.pending && attachment.kind === 'pairing' && this.pairingExp(attachment.id) <= now) ws.close(CLOSE.pairingExpired, 'pairing expired')
    }
    this.sql('DELETE FROM pairings WHERE exp <= ?', now)
    await this.retryPushes(now)
    await this.checkReceipts(now)
    await this.scheduleAlarm()
  }

  // ── Authentication: the first frame of every socket ──────────────────────────────────────

  private async authenticate(ws: WebSocket, value: unknown): Promise<void> {
    let frame: RelayClientFrame
    try {
      frame = requireRelayClientFrame(value)
    } catch {
      return ws.close(CLOSE.unauthorized, 'authenticate first')
    }
    if (!('auth' in frame)) return ws.close(CLOSE.unauthorized, 'authenticate first')
    const auth = frame.auth
    if (auth.room !== this.roomId()) return ws.close(CLOSE.unauthorized, 'unauthorized')

    let session: Extract<Attachment, { pending: false }> | null = null
    if ('owner' in auth) {
      if (await matchesHash(auth.owner, this.meta('ownerHash'))) session = { pending: false, kind: 'desktop', id: DESKTOP }
    } else if ('pairing' in auth) {
      const row = this.sql<{ id: string }>('SELECT id FROM pairings WHERE id = ? AND exp > ?', auth.pairing, Date.now())[0]
      if (row) session = { pending: false, kind: 'pairing', id: row.id }
    } else {
      const row = this.sql<{ token_hash: string }>('SELECT token_hash FROM devices WHERE id = ?', auth.device)[0]
      if (row && (await matchesHash(auth.token, row.token_hash))) session = { pending: false, kind: 'device', id: auth.device }
    }
    if (!session) return ws.close(CLOSE.unauthorized, 'unauthorized')

    // One live socket per identity: a reconnect replaces the previous one.
    for (const other of this.socketsOf(session.kind, session.id, ws)) other.close(CLOSE.replaced, 'replaced by a new connection')
    ws.serializeAttachment({ ...session, rate: (ws.deserializeAttachment() as Attachment | null)?.rate })

    const now = Date.now()
    if (session.kind === 'desktop') {
      this.setMeta('desktopLastSeen', String(now))
      if (this.meta('presence') !== 'online') {
        this.setMeta('presence', 'online')
        this.setMeta('desktopSince', new Date(now).toISOString())
      }
      this.broadcastPresence()
    } else {
      if (session.kind === 'device') {
        this.sql('UPDATE devices SET last_seen = ? WHERE id = ?', now, session.id)
        // The queued frames go down this socket now, so a pending push for them is no longer needed.
        this.sql('DELETE FROM push_retries WHERE device = ?', session.id)
      }
      this.notify(ws, this.presenceFor(session.id))
    }

    this.expireFrames(now)
    this.flushNotices(ws, session.id)
    this.redeliver(ws, session.id)
    await this.scheduleAlarm()
  }

  // ── Clear client frames after auth: push token registration, ack-only ────────────────────

  private async onClientFrame(ws: WebSocket, session: Extract<Attachment, { pending: false }>, frame: RelayClientFrame): Promise<void> {
    if ('auth' in frame) return ws.close(CLOSE.policy, 'already authenticated')
    if ('ack' in frame) {
      this.sql('DELETE FROM inbox WHERE owner = ? AND ref = ?', session.id, frame.ack)
      return
    }
    if (session.kind !== 'device') return ws.close(CLOSE.policy, 'pushToken is for paired phones only')
    if (frame.pushToken !== null && !EXPO_PUSH_TOKEN.test(frame.pushToken)) return ws.close(CLOSE.policy, 'pushToken is not an Expo push token')
    const old = this.sql<{ push_token: string | null }>('SELECT push_token FROM devices WHERE id = ?', session.id)[0]?.push_token ?? null
    // A new token (or none) cancels retries meant for the old one.
    this.sql('DELETE FROM push_retries WHERE device = ? AND token IS NOT ?', session.id, frame.pushToken)
    // The old token's coalescing slots go too, so a hint for the new one goes out at once, even
    // while a send to the old one is still in flight (that send only ever removes its own slot).
    if (old !== frame.pushToken) this.sql('DELETE FROM pushes WHERE device = ?', session.id)
    this.sql('UPDATE devices SET push_token = ? WHERE id = ?', frame.pushToken, session.id)
  }

  // ── Relay frames: route, queue, deliver ──────────────────────────────────────────────────

  private async onRelayFrame(ws: WebSocket, session: Extract<Attachment, { pending: false }>, frame: RelayFrame): Promise<void> {
    const now = Date.now()
    const sender = session.id

    if (session.kind !== 'desktop') {
      if (frame.to !== DESKTOP) return ws.close(CLOSE.policy, 'a phone may only address the desktop')
    } else if (frame.to === DESKTOP || !this.knowsRecipient(frame.to, now)) {
      // Unknown or revoked device, or an expired pairing: nothing to queue for, nothing to answer.
      return
    }

    // A desktop → phone frame is a result when it answers a command that phone sent; results are never dropped by the cap.
    const isResult =
      session.kind === 'desktop' &&
      (frame.ack === frame.ref || this.sql<{ seq: number }>('SELECT seq FROM inbox WHERE owner = ? AND sender = ? AND ref = ? LIMIT 1', DESKTOP, frame.to, frame.ref).length > 0)

    // A retransmission (same sender, recipient and ref still queued) is not stored or sent twice.
    const duplicate = this.sql<{ seq: number }>('SELECT seq FROM inbox WHERE owner = ? AND sender = ? AND ref = ? LIMIT 1', frame.to, sender, frame.ref).length > 0

    // A full phone inbox with no event left to drop refuses the result before consuming the
    // command's ack, so the command stays queued for the desktop and is answered again later.
    if (!duplicate && isResult && this.inboxFullOfResults(frame.to)) {
      this.notify(ws, { expired: true, ref: frame.ref })
      return
    }

    if (frame.ack !== undefined) this.sql('DELETE FROM inbox WHERE owner = ? AND ref = ?', sender, frame.ack)

    if (duplicate) {
      if (frame.to === DESKTOP && this.socketsOf('desktop', DESKTOP).length === 0) this.notify(ws, { queued: true, ref: frame.ref })
      return
    }

    // Only the clear routing fields travel on; ack / pushHint / pushText are consumed here.
    const forwarded: RelayFrame = { to: frame.to, ref: frame.ref, nonce: frame.nonce, ct: frame.ct }
    if (frame.ttl !== undefined) forwarded.ttl = frame.ttl
    const expires = now + (frame.ttl ?? DEFAULT_TTL_SECONDS) * 1000
    this.sql('INSERT INTO inbox (owner, sender, ref, frame, expires, result) VALUES (?, ?, ?, ?, ?, ?)', frame.to, sender, frame.ref, JSON.stringify(forwarded), expires, isResult ? 1 : 0)
    if (frame.to !== DESKTOP) this.capInbox(frame.to)
    else this.capCommands(ws, sender)

    const recipientKind = frame.to === DESKTOP ? 'desktop' : this.sql<{ id: string }>('SELECT id FROM devices WHERE id = ?', frame.to).length > 0 ? 'device' : 'pairing'
    const recipient = this.socketsOf(recipientKind, frame.to)[0]
    if (recipient) {
      // Live delivery keeps deliverySeq order: everything before this frame already went down this socket.
      recipient.send(JSON.stringify(forwarded))
    } else if (frame.to === DESKTOP) {
      this.notify(ws, { queued: true, ref: frame.ref })
    } else if (frame.pushHint && recipientKind === 'device') {
      this.maybePush(frame.to, frame.pushHint, frame.pushText, now)
    }
    await this.scheduleAlarm()
  }

  private knowsRecipient(id: string, now: number): boolean {
    if (this.sql<{ id: string }>('SELECT id FROM devices WHERE id = ?', id).length > 0) return true
    return this.sql<{ id: string }>('SELECT id FROM pairings WHERE id = ? AND exp > ?', id, now).length > 0
  }

  /** `true` when a phone's inbox is at the cap and every frame in it is a result (nothing the cap may drop). */
  private inboxFullOfResults(owner: string): boolean {
    const row = this.sql<{ n: number; events: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(result = 0), 0) AS events FROM inbox WHERE owner = ?', owner)[0]
    return (row?.n ?? 0) >= MAX_UNACKED_PER_PHONE && (row?.events ?? 0) === 0
  }

  /** Keeps a phone's inbox at `MAX_UNACKED_PER_PHONE`, dropping the oldest events; results stay. */
  private capInbox(owner: string): void {
    const total = this.sql<{ n: number }>('SELECT COUNT(*) AS n FROM inbox WHERE owner = ?', owner)[0]?.n ?? 0
    const excess = total - MAX_UNACKED_PER_PHONE
    if (excess <= 0) return
    this.sql('DELETE FROM inbox WHERE seq IN (SELECT seq FROM inbox WHERE owner = ? AND result = 0 ORDER BY seq ASC LIMIT ?)', owner, excess)
  }

  /**
   * Keeps one phone's frames waiting for the desktop at `MAX_UNACKED_PER_PHONE` while the Mac
   * sleeps, so a phone cannot fill the room's storage by reconnecting past the rate limit. The
   * oldest go, and the phone is told `{ expired, ref }` as if their ttl had passed.
   */
  private capCommands(ws: WebSocket, sender: string): void {
    const total = this.sql<{ n: number }>('SELECT COUNT(*) AS n FROM inbox WHERE owner = ? AND sender = ?', DESKTOP, sender)[0]?.n ?? 0
    const excess = total - MAX_UNACKED_PER_PHONE
    if (excess <= 0) return
    const dropped = this.sql<{ seq: number; ref: string }>('SELECT seq, ref FROM inbox WHERE owner = ? AND sender = ? ORDER BY seq ASC LIMIT ?', DESKTOP, sender, excess)
    for (const row of dropped) {
      this.sql('DELETE FROM inbox WHERE seq = ?', row.seq)
      this.notify(ws, { expired: true, ref: row.ref })
    }
  }

  /** Sends every unacked frame for `owner` in deliverySeq order. Live frames that arrive later are appended behind them. */
  private redeliver(ws: WebSocket, owner: string): void {
    for (const row of this.sql<InboxRow>('SELECT * FROM inbox WHERE owner = ? ORDER BY seq ASC', owner)) ws.send(row.frame)
  }

  /** Drops frames whose ttl passed and tells each sender `{ expired, ref }`, now or on its next connection. */
  private expireFrames(now: number): void {
    const rows = this.sql<InboxRow>('SELECT * FROM inbox WHERE expires <= ? ORDER BY seq ASC', now)
    if (rows.length === 0) return
    this.sql('DELETE FROM inbox WHERE expires <= ?', now)
    for (const row of rows) {
      const notice: RelayNotice = { expired: true, ref: row.ref }
      const kind = row.sender === DESKTOP ? 'desktop' : this.sql<{ id: string }>('SELECT id FROM devices WHERE id = ?', row.sender).length > 0 ? 'device' : 'pairing'
      const live = this.socketsOf(kind, row.sender)[0]
      if (live) this.notify(live, notice)
      else this.storeNotice(row.sender, notice)
    }
  }

  private storeNotice(owner: string, notice: RelayNotice): void {
    if (owner !== DESKTOP && this.sql<{ id: string }>('SELECT id FROM devices WHERE id = ?', owner).length === 0) return // pairing sockets are short-lived
    this.sql('INSERT INTO notices (owner, notice) VALUES (?, ?)', owner, JSON.stringify(notice))
    this.sql('DELETE FROM notices WHERE owner = ? AND seq NOT IN (SELECT seq FROM notices WHERE owner = ? ORDER BY seq DESC LIMIT ?)', owner, owner, MAX_NOTICES_PER_OWNER)
  }

  private flushNotices(ws: WebSocket, owner: string): void {
    const rows = this.sql<{ seq: number; notice: string }>('SELECT seq, notice FROM notices WHERE owner = ? ORDER BY seq ASC', owner)
    if (rows.length === 0) return
    this.sql('DELETE FROM notices WHERE owner = ?', owner)
    for (const row of rows) ws.send(row.notice)
  }

  // ── Presence ─────────────────────────────────────────────────────────────────────────────

  private async touchDesktop(): Promise<void> {
    this.setMeta('desktopLastSeen', String(Date.now()))
  }

  private async desktopOffline(): Promise<void> {
    if (this.meta('presence') === 'offline') return
    this.setMeta('presence', 'offline')
    this.setMeta('desktopSince', new Date().toISOString())
    this.broadcastPresence()
  }

  private presenceFor(phoneId: string): RelayNotice {
    const online = this.meta('presence') === 'online' && this.socketsOf('desktop', DESKTOP).length > 0
    const queued = this.sql<{ n: number }>('SELECT COUNT(*) AS n FROM inbox WHERE owner = ? AND sender = ?', DESKTOP, phoneId)[0]?.n ?? 0
    return { presence: online ? 'online' : 'offline', since: this.meta('desktopSince') ?? new Date(0).toISOString(), queued }
  }

  private broadcastPresence(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment && !attachment.pending && attachment.kind !== 'desktop') this.notify(ws, this.presenceFor(attachment.id))
    }
  }

  // ── Push ─────────────────────────────────────────────────────────────────────────────────

  private maybePush(deviceId: string, category: NotificationCategory, text: string | undefined, now: number): void {
    const token = this.sql<{ push_token: string | null }>('SELECT push_token FROM devices WHERE id = ?', deviceId)[0]?.push_token
    if (!token) return
    // A retry is already pending for this category: the newest hint replaces its body, no second push.
    const pending = this.sql<{ attempt: number }>('SELECT attempt FROM push_retries WHERE device = ? AND category = ?', deviceId, category)[0]
    if (pending) {
      this.sql('UPDATE push_retries SET text = ?, token = ? WHERE device = ? AND category = ?', text ?? null, token, deviceId, category)
      return
    }
    const last = this.sql<{ at: number }>('SELECT at FROM pushes WHERE device = ? AND category = ?', deviceId, category)[0]?.at
    if (last !== undefined && now - last < this.config.pushCoalesceMs) return
    this.sql('INSERT OR REPLACE INTO pushes (device, category, at) VALUES (?, ?, ?)', deviceId, category, now)
    this.ctx.waitUntil(this.sendPush(deviceId, category, token, text, 0, now))
  }

  /**
   * One attempt (0 = the first send). `ok` records the ticket for its receipt; `DeviceNotRegistered`
   * clears the token; `retry` schedules the next attempt while the budget lasts
   * (`pushRetryDelaysMs`, honouring a 429's `Retry-After`); anything else gives up. A failed or
   * abandoned push does not count for coalescing, so a later hint can try again.
   */
  private async sendPush(deviceId: string, category: NotificationCategory, token: string, text: string | undefined, attempt: number, at: number): Promise<void> {
    const { outcome, ticketId, retryAfterMs } = await sendExpoPush(this.config.expoPushUrl, pushMessage(token, category, text))
    const now = Date.now()
    // The token changed, was removed or the device was revoked while this attempt was in flight.
    const device = this.sql<{ push_token: string | null; last_seen: number | null }>('SELECT push_token, last_seen FROM devices WHERE id = ?', deviceId)[0]
    if (device?.push_token !== token) {
      // Its coalescing slot went with the token change.
      this.sql('DELETE FROM push_retries WHERE device = ? AND category = ? AND token = ?', deviceId, category, token)
      return
    }
    // The phone connected while this attempt was in flight and got the queued frames itself:
    // no retry (its connect already deleted the pending one).
    const reconnected = device.last_seen !== null && device.last_seen >= at
    if (outcome === 'ok') {
      this.sql('DELETE FROM push_retries WHERE device = ? AND category = ?', deviceId, category)
      if (attempt > 0) this.sql('INSERT OR REPLACE INTO pushes (device, category, at) VALUES (?, ?, ?)', deviceId, category, now)
      if (ticketId) {
        this.sql('INSERT OR REPLACE INTO receipts (ticket, device, token, sent_at, check_at) VALUES (?, ?, ?, ?, ?)', ticketId, deviceId, token, now, now + this.config.pushReceiptDelayMs)
        this.sql('DELETE FROM receipts WHERE ticket NOT IN (SELECT ticket FROM receipts ORDER BY sent_at DESC LIMIT ?)', MAX_PENDING_RECEIPTS)
      }
    } else if (outcome === 'DeviceNotRegistered') {
      this.clearPushToken(deviceId, token)
    } else if (outcome === 'retry' && attempt < this.config.pushRetryDelaysMs.length && !reconnected) {
      const wait = Math.max(this.config.pushRetryDelaysMs[attempt], retryAfterMs ?? 0)
      // Keep the newest body if a hint replaced it while this attempt was in flight.
      this.sql(
        `INSERT INTO push_retries (device, category, token, text, attempt, next_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (device, category) DO UPDATE SET attempt = excluded.attempt, next_at = excluded.next_at`,
        deviceId,
        category,
        token,
        text ?? null,
        attempt + 1,
        now + wait
      )
      this.sql('DELETE FROM pushes WHERE device = ? AND category = ? AND at = ?', deviceId, category, at)
    } else {
      // Permanent failure, the retry budget is spent, or the phone has the frames already.
      this.sql('DELETE FROM push_retries WHERE device = ? AND category = ?', deviceId, category)
      this.sql('DELETE FROM pushes WHERE device = ? AND category = ? AND at = ?', deviceId, category, at)
    }
    await this.scheduleAlarm()
  }

  /**
   * Sends the oldest due retries (`PUSH_RETRIES_PER_ALARM`), one attempt each; `sendPush`
   * reschedules or settles them.
   * The due rows are leased first, for longer than a request can take, so an alarm firing
   * meanwhile does not send one twice; the alarm is armed for the lease before any request goes
   * out, so a handler cut off mid-request picks them up again a minute later. Each row is read
   * again right before its send, because an earlier send in this loop (or any event while it was
   * awaited) may have cancelled it, cleared the token or replaced the body.
   */
  private async retryPushes(now: number): Promise<void> {
    const due = this.sql<{ device: string; category: NotificationCategory }>('SELECT device, category FROM push_retries WHERE next_at <= ? ORDER BY next_at ASC LIMIT ?', now, PUSH_RETRIES_PER_ALARM)
    if (due.length === 0) return
    const lease = now + PUSH_RETRY_LEASE_MS
    for (const row of due) this.sql('UPDATE push_retries SET next_at = ? WHERE device = ? AND category = ?', lease, row.device, row.category)
    await this.scheduleAlarm()
    for (const { device, category } of due) {
      const row = this.sql<{ token: string; text: string | null; attempt: number }>(
        'SELECT token, text, attempt FROM push_retries WHERE device = ? AND category = ? AND next_at = ?',
        device,
        category,
        lease
      )[0]
      if (!row) continue
      const current = this.sql<{ push_token: string | null }>('SELECT push_token FROM devices WHERE id = ?', device)[0]?.push_token
      if (current !== row.token) {
        this.sql('DELETE FROM push_retries WHERE device = ? AND category = ? AND token = ?', device, category, row.token)
        continue
      }
      // The phone reconnected and got the queued frames over its socket: the push is not needed.
      if (this.socketsOf('device', device).length > 0) {
        this.sql('DELETE FROM push_retries WHERE device = ? AND category = ?', device, category)
        continue
      }
      await this.sendPush(device, category, row.token, row.text ?? undefined, row.attempt, now)
    }
  }

  /**
   * Reads the receipts that are due (an `ok` ticket only means Expo accepted the message; APNs /
   * FCM report a dead token later, in the receipt). `DeviceNotRegistered` clears the token, but
   * only if it is still the one that push went to. A ticket without a receipt yet, or a failed
   * call, is asked again one delay later, until Expo's one-day retention has passed.
   */
  private async checkReceipts(now: number): Promise<void> {
    const due = this.sql<{ ticket: string; device: string; token: string; sent_at: number }>(
      'SELECT ticket, device, token, sent_at FROM receipts WHERE check_at <= ? ORDER BY check_at ASC LIMIT ?',
      now,
      RECEIPT_IDS_PER_CALL
    )
    if (due.length === 0) return
    const receipts = await fetchReceipts(this.config.expoReceiptsUrl, due.map((r) => r.ticket))
    for (const row of due) {
      const outcome = receipts?.get(row.ticket)
      if (outcome === 'DeviceNotRegistered') this.clearPushToken(row.device, row.token)
      if (outcome !== undefined || now - row.sent_at >= RECEIPT_MAX_AGE_MS) this.sql('DELETE FROM receipts WHERE ticket = ?', row.ticket)
      else this.sql('UPDATE receipts SET check_at = ? WHERE ticket = ?', now + this.config.pushReceiptDelayMs, row.ticket)
    }
  }

  private clearPushToken(deviceId: string, token: string): void {
    this.sql('UPDATE devices SET push_token = NULL WHERE id = ? AND push_token = ?', deviceId, token)
    this.sql('DELETE FROM receipts WHERE device = ? AND token = ?', deviceId, token)
    this.sql('DELETE FROM push_retries WHERE device = ? AND token = ?', deviceId, token)
  }

  // ── Revocation ───────────────────────────────────────────────────────────────────────────

  private revokeDevice(deviceId: string): void {
    this.sql('DELETE FROM devices WHERE id = ?', deviceId)
    this.sql('DELETE FROM inbox WHERE owner = ? OR sender = ?', deviceId, deviceId)
    this.sql('DELETE FROM notices WHERE owner = ?', deviceId)
    this.sql('DELETE FROM pushes WHERE device = ?', deviceId)
    this.sql('DELETE FROM receipts WHERE device = ?', deviceId)
    this.sql('DELETE FROM push_retries WHERE device = ?', deviceId)
    for (const ws of this.socketsOf('device', deviceId)) ws.close(CLOSE.revoked, 'device revoked')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  private roomId(): string {
    return this.ctx.id.toString()
  }

  /** When a pairing stops being valid; `0` once it is gone (expired and deleted, or never registered). */
  private pairingExp(id: string): number {
    return this.sql<{ exp: number }>('SELECT exp FROM pairings WHERE id = ?', id)[0]?.exp ?? 0
  }

  private sql<T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...params).toArray()
  }

  private meta(key: string): string | undefined {
    return this.sql<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)[0]?.value
  }

  private setMeta(key: string, value: string): void {
    this.sql('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value)
  }

  private socketsOf(kind: SocketKind, id: string, except?: WebSocket): WebSocket[] {
    const out: WebSocket[] = []
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment && !attachment.pending && attachment.kind === kind && attachment.id === id) out.push(ws)
    }
    return out
  }

  private notify(ws: WebSocket, notice: RelayNotice): void {
    try {
      ws.send(JSON.stringify(notice))
    } catch {
      // The socket is closing; the notice is not worth keeping.
    }
  }

  /**
   * One alarm for everything time-based: auth deadlines, pairing expiry, the desktop heartbeat
   * check, the next frame expiry, the next push retry and the next push receipt to read. No sockets and nothing queued means no alarm, so an idle room never wakes.
   */
  private async scheduleAlarm(): Promise<void> {
    let next = Infinity
    let desktopConnected = false
    const pairingSockets: string[] = []
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (!attachment) continue
      if (attachment.pending) next = Math.min(next, attachment.deadline)
      else if (attachment.kind === 'desktop') desktopConnected = true
      else if (attachment.kind === 'pairing') pairingSockets.push(attachment.id)
    }
    for (const id of pairingSockets) next = Math.min(next, this.pairingExp(id))
    if (desktopConnected) next = Math.min(next, Number(this.meta('desktopLastSeen') ?? Date.now()) + 2 * this.config.heartbeatMs)
    const soonest = this.sql<{ t: number | null }>('SELECT MIN(expires) AS t FROM inbox')[0]?.t
    if (soonest !== null && soonest !== undefined) next = Math.min(next, soonest)
    const receipt = this.sql<{ t: number | null }>('SELECT MIN(check_at) AS t FROM receipts')[0]?.t
    if (receipt !== null && receipt !== undefined) next = Math.min(next, receipt)
    const retry = this.sql<{ t: number | null }>('SELECT MIN(next_at) AS t FROM push_retries')[0]?.t
    if (retry !== null && retry !== undefined) next = Math.min(next, retry)
    if (next === Infinity) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > next || current < Date.now()) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1))
  }
}

/** `{ auth }`, `{ pushToken }` or an ack-only `{ ack }`; a RelayFrame may carry `ack` too, but it always has `ct`. */
function isClientFrame(value: unknown): boolean {
  return typeof value === 'object' && value !== null && ('auth' in value || 'pushToken' in value || ('ack' in value && !('ct' in value)))
}

/** A JSON body of at most 4 KiB checked by the shared contract's guard, or the `400` to answer. */
async function readBody<T>(request: Request, guard: (v: unknown) => T): Promise<T | { error: Response }> {
  let value: unknown
  try {
    const text = await request.text()
    if (text.length > 4096) return { error: json({ error: 'body too large' }, 400) }
    value = JSON.parse(text)
  } catch {
    return { error: json({ error: 'JSON body required' }, 400) }
  }
  try {
    return guard(value)
  } catch (e) {
    return { error: json({ error: e instanceof ProtocolError ? e.message : 'invalid body' }, 400) }
  }
}
