/**
 * The relay Worker (ADR-0001, "Relay deployment and room creation"): the public routes in
 * front of one Durable Object per room. It authenticates room creation with the admin token
 * before any Durable Object is touched, refuses anything that is not TLS, refuses credentials
 * in a WebSocket URL or upgrade header, and otherwise hands the request to the room. It logs
 * nothing.
 *
 *   POST   /rooms                          Authorization: Bearer <ADMIN_TOKEN>, { ownerSecretHash } → { roomId }
 *   POST   /rooms/:room/pairings           Authorization: Bearer <ownerSecret>, { pairingId, exp }
 *   POST   /rooms/:room/devices            Authorization: Bearer <ownerSecret>, { deviceId, tokenHash }
 *   DELETE /rooms/:room/devices/:device    Authorization: Bearer <ownerSecret>   (revocation)
 *   DELETE /rooms/:room                    Authorization: Bearer <ownerSecret>   (rotate credentials)
 *   GET    /rooms/:room/ws                 WebSocket; the first frame is `{ auth }`, nothing in the URL
 */
import { isSha256Hex, matchesHash, bearerOf, sha256Hex } from './auth'
import type { Env } from './env'

// The entry module may export only handlers and Durable Object classes (workerd checks every export).
export { Room } from './room'

/** Failed admin attempts per IP before `429`, and how long the window lasts. */
const ADMIN_FAILURES_PER_WINDOW = 5
const ADMIN_WINDOW_MS = 15 * 60 * 1000

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.protocol !== 'https:') return json({ error: 'https required' }, 400)

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] !== 'rooms') return json({ error: 'not found' }, 404)

    if (segments.length === 1) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      return createRoom(request, env)
    }

    let id: DurableObjectId
    try {
      id = env.ROOM.idFromString(segments[1])
    } catch {
      return json({ error: 'no such room' }, 404)
    }
    const rest = segments.slice(2)
    const stub = env.ROOM.get(id)

    if (rest.length === 1 && rest[0] === 'ws') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket upgrade required' }, 426)
      if (url.search.length > 0) return json({ error: 'credentials in the URL are refused; send { auth } as the first frame' }, 400)
      for (const name of FORBIDDEN_UPGRADE_HEADERS) if (request.headers.has(name)) return json({ error: `credentials in the ${name} header are refused; send { auth } as the first frame` }, 400)
      return stub.fetch(new Request('https://room/ws', request))
    }

    if (rest.length === 0 && request.method === 'DELETE') return stub.fetch(new Request('https://room/', request))
    if (rest.length === 1 && rest[0] === 'pairings' && request.method === 'POST') return stub.fetch(new Request('https://room/pairings', request))
    if (rest.length === 1 && rest[0] === 'devices' && request.method === 'POST') return stub.fetch(new Request('https://room/devices', request))
    if (rest.length === 2 && rest[0] === 'devices' && request.method === 'DELETE') return stub.fetch(new Request(`https://room/devices/${encodeURIComponent(rest[1])}`, request))
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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'JSON body required' }, 400)
  }
  const ownerSecretHash = (body as { ownerSecretHash?: unknown } | null)?.ownerSecretHash
  if (!isSha256Hex(ownerSecretHash)) return json({ error: 'ownerSecretHash must be a hex SHA-256 of the owner secret' }, 400)

  const id = env.ROOM.newUniqueId()
  const res = await env.ROOM.get(id).fetch('https://room/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerSecretHash })
  })
  if (res.status !== 201) return json({ error: 'room creation failed' }, 500)
  return json({ roomId: id.toString() }, 201)
}
