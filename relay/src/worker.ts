/**
 * The relay Worker (ADR-0001, "Relay deployment and room creation"): the public routes in
 * front of one Durable Object per room. The paths and bodies are the shared contract in
 * `@huntgry/remote-protocol` (`RELAY_PATHS`, `relay-http.ts`), which the desktop calls too.
 * It authenticates room creation with the admin token before any Durable Object is touched,
 * refuses anything that is not TLS, refuses credentials in a WebSocket URL or upgrade header,
 * and otherwise hands the request to the room. It logs nothing.
 *
 *   POST   /rooms                          Authorization: Bearer <ADMIN_TOKEN>, { ownerSecretHash } → { roomId }
 *   POST   /rooms/:room/pairings           Authorization: Bearer <ownerSecret>, { pairingId, exp }
 *   POST   /rooms/:room/devices            Authorization: Bearer <ownerSecret>, { deviceId, tokenHash }
 *   DELETE /rooms/:room/devices/:device    Authorization: Bearer <ownerSecret>   (revocation)
 *   DELETE /rooms/:room                    Authorization: Bearer <ownerSecret>   (rotate credentials)
 *   GET    /ws                             WebSocket; the first frame is `{ auth }` and names the room
 *   GET    /rooms/:room/ws                 the same socket, routed by path (not in the shared contract; see README)
 */
import {
  ProtocolError,
  RELAY_PATHS,
  requireCreateRoomRequest,
  requireRelayClientFrame,
  type CreateRoomResponse
} from '@huntgry/remote-protocol'
import { bearerOf, matchesHash, sha256Hex } from './auth'
import { configOf, type Env } from './env'
import { CLOSE } from './room'

// The entry module may export only handlers and Durable Object classes (workerd checks every export).
export { Room } from './room'

/** Failed admin attempts per IP before `429`, and how long the window lasts. */
const ADMIN_FAILURES_PER_WINDOW = 5
const ADMIN_WINDOW_MS = 15 * 60 * 1000

/** The `auth` frame is small; anything bigger before authentication is refused unread. */
const AUTH_FRAME_MAX_CHARS = 2048
/** Frames a client may send while `/ws` is still connecting to its room (the desktop sends a heartbeat right after auth). */
const PENDING_FRAMES_MAX = 16

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })

/**
 * Per-isolate memory: a wrong admin token costs the caller one entry here and never reaches
 * a Durable Object. Cloudflare may run several isolates, so this is a brake, not a wall; the
 * token itself is 32 random bytes.
 */
const adminFailures = new Map<string, { count: number; resetAt: number }>()

function failuresFor(ip: string, now: number): { count: number; resetAt: number } {
  const entry = adminFailures.get(ip)
  if (entry && entry.resetAt > now) return entry
  const fresh = { count: 0, resetAt: now + ADMIN_WINDOW_MS }
  adminFailures.set(ip, fresh)
  if (adminFailures.size > 10_000) for (const [key, value] of adminFailures) if (value.resetAt <= now) adminFailures.delete(key)
  return fresh
}

/** Anything that could carry a credential is refused on the upgrade request itself. */
const FORBIDDEN_UPGRADE_HEADERS = ['authorization', 'cookie', 'sec-websocket-protocol', 'x-auth-token', 'x-owner-secret', 'x-relay-token']

/** `400` when an upgrade request could carry a credential or is not an upgrade at all, else `null`. */
function refuseUpgrade(request: Request, url: URL): Response | null {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket upgrade required' }, 426)
  if (url.search.length > 0) return json({ error: 'credentials in the URL are refused; send { auth } as the first frame' }, 400)
  for (const name of FORBIDDEN_UPGRADE_HEADERS) if (request.headers.has(name)) return json({ error: `credentials in the ${name} header are refused; send { auth } as the first frame` }, 400)
  return null
}

function roomStub(env: Env, roomId: string): DurableObjectStub | null {
  try {
    return env.ROOM.get(env.ROOM.idFromString(roomId))
  } catch {
    return null
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.protocol !== 'https:') return json({ error: 'https required' }, 400)

    if (url.pathname === RELAY_PATHS.socket) return refuseUpgrade(request, url) ?? proxySocket(env)

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== 'rooms') return json({ error: 'not found' }, 404)

    if (url.pathname === RELAY_PATHS.rooms) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      return createRoom(request, env)
    }

    const stub = roomStub(env, segments[1])
    if (!stub) return json({ error: 'no such room' }, 404)
    const rest = segments.slice(2)

    if (rest.length === 1 && rest[0] === 'ws') return refuseUpgrade(request, url) ?? stub.fetch(new Request('https://room/ws', request))

    if (rest.length === 0 && request.method === 'DELETE') return stub.fetch(new Request('https://room/', request))
    if (rest.length === 1 && rest[0] === 'pairings' && request.method === 'POST') return stub.fetch(new Request('https://room/pairings', request))
    if (rest.length === 1 && rest[0] === 'devices' && request.method === 'POST') return stub.fetch(new Request('https://room/devices', request))
    if (rest.length === 2 && rest[0] === 'devices' && request.method === 'DELETE') {
      // The path segment is still percent-encoded (RELAY_PATHS.device encodes the id); decode it once here.
      let deviceId: string
      try {
        deviceId = decodeURIComponent(rest[1])
      } catch {
        return json({ error: 'no such device' }, 404)
      }
      return stub.fetch(new Request(`https://room/devices/${encodeURIComponent(deviceId)}`, request))
    }
    return json({ error: 'not found' }, 404)
  }
} satisfies ExportedHandler<Env>

async function createRoom(request: Request, env: Env): Promise<Response> {
  const now = Date.now()
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const failures = failuresFor(ip, now)
  if (failures.count >= ADMIN_FAILURES_PER_WINDOW) {
    return json({ error: 'too many failed attempts' }, 429, { 'retry-after': String(Math.ceil((failures.resetAt - now) / 1000)) })
  }

  const presented = bearerOf(request)
  // The secret is compared through SHA-256 so a wrong token of any length takes the same time.
  const expectedHash = env.ADMIN_TOKEN ? await sha256Hex(env.ADMIN_TOKEN) : undefined
  if (!env.ADMIN_TOKEN || !presented || !(await matchesHash(presented, expectedHash))) {
    failures.count += 1
    return json({ error: 'unauthorized' }, 401)
  }

  let ownerSecretHash: string
  try {
    ownerSecretHash = requireCreateRoomRequest(await request.json()).ownerSecretHash
  } catch (e) {
    return json({ error: e instanceof ProtocolError ? e.message : 'JSON body required' }, 400)
  }

  const id = env.ROOM.newUniqueId()
  const res = await env.ROOM.get(id).fetch('https://room/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerSecretHash })
  })
  if (res.status !== 201) return json({ error: 'room creation failed' }, 500)
  const created: CreateRoomResponse = { roomId: id.toString() }
  return json(created, 201)
}

// ── GET /ws: the room is named only in the first frame ─────────────────────────────────────

/**
 * `GET /ws` (RELAY_PATHS.socket) has no room in its URL, so the Worker accepts the socket,
 * reads the `{ auth }` frame, opens a socket to that room's Durable Object, hands it the auth
 * frame unchanged and then forwards both ways without reading anything. The room checks the
 * credential exactly as on a direct socket; the Worker only checks that the frame is an auth
 * frame naming a well-formed room id. Close codes from the room (revoked, replaced, …) reach
 * the client unchanged.
 */
function proxySocket(env: Env): Response {
  const pair = new WebSocketPair()
  const [client, server] = [pair[0], pair[1]]
  server.accept()

  let upstream: WebSocket | null = null
  let connecting = false
  let done = false
  const pending: string[] = []

  const finish = (code: number, reason: string, upstreamCode = code): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    safeClose(server, code, reason)
    if (upstream) safeClose(upstream, upstreamCode, reason)
  }
  const timer = setTimeout(() => finish(CLOSE.authTimeout, 'authentication timeout'), configOf(env).authTimeoutMs)

  server.addEventListener('message', (event) => {
    if (done) return
    const data = event.data
    if (upstream) return void upstream.send(data)
    if (connecting) {
      if (pending.length >= PENDING_FRAMES_MAX || typeof data !== 'string') return finish(CLOSE.policy, 'too many frames before the room answered')
      pending.push(data)
      return
    }
    const roomId = typeof data === 'string' && data.length <= AUTH_FRAME_MAX_CHARS ? authRoomOf(data) : null
    const stub = roomId ? roomStub(env, roomId) : null
    if (!stub) return finish(CLOSE.unauthorized, 'authenticate first')
    connecting = true
    void connectRoom(stub).then((ws) => {
      if (!ws) return finish(CLOSE.unauthorized, 'unauthorized')
      if (done) return safeClose(ws, 1000, 'client gone')
      upstream = ws
      ws.accept()
      ws.addEventListener('message', (e) => {
        if (!done) server.send(e.data)
      })
      ws.addEventListener('close', (e) => finish(clientCode(e.code), e.reason))
      ws.addEventListener('error', () => finish(1011, 'relay error'))
      clearTimeout(timer) // the room runs its own auth timeout from here
      ws.send(data)
      for (const frame of pending.splice(0)) ws.send(frame)
    })
  })
  server.addEventListener('close', (e) => finish(1000, 'client closed', roomCode(e.code)))
  server.addEventListener('error', () => finish(1011, 'client error', 1000))

  return new Response(null, { status: 101, webSocket: client })
}

/** The `room` of an `auth` frame, or `null` for anything else (the room re-validates the whole frame). */
function authRoomOf(text: string): string | null {
  try {
    const frame = requireRelayClientFrame(JSON.parse(text))
    return 'auth' in frame ? frame.auth.room : null
  } catch {
    return null
  }
}

async function connectRoom(stub: DurableObjectStub): Promise<WebSocket | null> {
  try {
    const res = await stub.fetch('https://room/ws', { headers: { upgrade: 'websocket' } })
    return res.webSocket ?? null
  } catch {
    return null
  }
}

/** Codes a peer may send: 1000 and the application range pass through; 1005 / 1006 (no code, abnormal) cannot be sent. */
const sendable = (code: number): boolean => code === 1000 || code === 1008 || code === 1011 || (code >= 3000 && code <= 4999)
const clientCode = (code: number): number => (sendable(code) ? code : 1011)
const roomCode = (code: number): number => (sendable(code) ? code : 1000)

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason.slice(0, 120))
  } catch {
    // already closed
  }
}
