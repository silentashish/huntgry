/**
 * Test harness: bundles the Worker with esbuild, runs it under Miniflare (workerd, SQLite
 * Durable Objects, real alarms) and talks to it from Node with HTTP and WebSocket clients.
 * Outbound `fetch` from the Worker (the Expo push API) lands in `relay.pushes`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, Response as MfResponse, type Request as MfRequest, type WebSocket as MfWebSocket } from 'miniflare'
import type { RelayClientFrame, RelayFrame } from '@huntgry/remote-protocol'

const here = dirname(fileURLToPath(import.meta.url))

let bundle: Promise<string> | undefined
export function bundleWorker(): Promise<string> {
  bundle ??= build({
    entryPoints: [resolve(here, '../src/worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    external: ['cloudflare:*'],
    logLevel: 'silent'
  }).then((r) => r.outputFiles[0].text)
  return bundle
}

export const ORIGIN = 'https://relay.test'
export const ADMIN_TOKEN = 'admin-' + randomBytes(16).toString('hex')

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
export const randomId = (prefix = 'id'): string => `${prefix}-${randomBytes(8).toString('hex')}`
/** A syntactically valid 24-byte nonce / some ciphertext (the relay never opens them). */
export const nonce = (): string => randomBytes(24).toString('base64')
export const ciphertext = (bytes = 48): string => randomBytes(bytes).toString('base64')

export interface PushCall {
  url: string
  body: { to: string; title: string; body: string; data: { category: string }; sound?: string; priority?: string }[]
}

export interface RelayOptions {
  bindings?: Record<string, string>
  /** What the fake Expo endpoint answers; default: one `ok` ticket. */
  pushReply?: (call: PushCall) => unknown
}

export interface Closed {
  code: number
  reason: string
}

export class Client {
  private readonly queue: unknown[] = []
  private readonly waiters: ((v: unknown) => void)[] = []
  readonly closed: Promise<Closed>
  private done = false

  constructor(readonly ws: MfWebSocket) {
    this.closed = new Promise((resolveClosed) => {
      ws.addEventListener('close', (e) => {
        this.done = true
        resolveClosed({ code: (e as CloseEvent).code, reason: (e as CloseEvent).reason })
      })
    })
    ws.addEventListener('message', (e) => {
      const value = JSON.parse(String((e as MessageEvent).data))
      const waiter = this.waiters.shift()
      if (waiter) waiter(value)
      else this.queue.push(value)
    })
    ws.accept()
  }

  send(frame: RelayClientFrame | RelayFrame | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame))
  }

  sendRaw(text: string): void {
    this.ws.send(text)
  }

  /** The next message, or a rejection after `timeoutMs`. */
  next<T = unknown>(timeoutMs = 3000): Promise<T> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as T)
    return new Promise<T>((resolveNext, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error(`no message within ${timeoutMs} ms`))
      }, timeoutMs)
      const waiter = (v: unknown): void => {
        clearTimeout(timer)
        resolveNext(v as T)
      }
      this.waiters.push(waiter)
    })
  }

  /** Resolves when nothing arrives for `quietMs`; rejects on an unexpected message. */
  async expectNone(quietMs = 400): Promise<void> {
    try {
      const msg = await this.next(quietMs)
      throw new Error(`unexpected message ${JSON.stringify(msg)}`)
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('no message')) throw e
    }
  }

  get isClosed(): boolean {
    return this.done
  }

  /**
   * Closes from the client side and waits for the room to have processed it. The close event
   * on this side only fires after workerd's own timeout, so tests never await `closed` here.
   */
  async close(): Promise<void> {
    if (!this.done) this.ws.close(1000, 'test done')
    await sleep(150)
  }
}

export class Relay {
  readonly pushes: PushCall[] = []
  private constructor(
    readonly mf: Miniflare,
    readonly options: RelayOptions
  ) {}

  static async start(options: RelayOptions = {}): Promise<Relay> {
    const script = await bundleWorker()
    let relay: Relay
    const mf = new Miniflare({
      modules: [{ type: 'ESModule', path: 'worker.js', contents: script }],
      compatibilityDate: '2025-06-01',
      durableObjects: { ROOM: { className: 'Room', useSQLite: true } },
      bindings: { ADMIN_TOKEN, ...options.bindings },
      outboundService: async (request: MfRequest) => {
        const call: PushCall = { url: request.url, body: JSON.parse(await request.text()) }
        relay.pushes.push(call)
        const reply = options.pushReply ? options.pushReply(call) : { data: [{ status: 'ok' }] }
        return new MfResponse(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } })
      }
    })
    relay = new Relay(mf, options)
    await mf.ready
    return relay
  }

  /** Plain HTTP against the Worker. `init.headers` may add `cf-connecting-ip` or `authorization`. */
  async fetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; origin?: string } = {}): Promise<{ status: number; json: unknown; headers: Headers }> {
    const res = await this.mf.dispatchFetch(`${init.origin ?? ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, json, headers: res.headers as unknown as Headers }
  }

  async createRoom(ownerSecret: string, adminToken = ADMIN_TOKEN): Promise<string> {
    const res = await this.fetch('/rooms', { method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: { ownerSecretHash: sha256(ownerSecret) } })
    if (res.status !== 201) throw new Error(`createRoom: ${res.status} ${JSON.stringify(res.json)}`)
    return (res.json as { roomId: string }).roomId
  }

  async registerDevice(roomId: string, ownerSecret: string, deviceId: string, relayToken: string): Promise<number> {
    const res = await this.fetch(`/rooms/${roomId}/devices`, { method: 'POST', headers: { authorization: `Bearer ${ownerSecret}` }, body: { deviceId, tokenHash: sha256(relayToken) } })
    return res.status
  }

  async registerPairing(roomId: string, ownerSecret: string, pairingId: string, expMs = 120_000): Promise<number> {
    const res = await this.fetch(`/rooms/${roomId}/pairings`, { method: 'POST', headers: { authorization: `Bearer ${ownerSecret}` }, body: { pairingId, exp: new Date(Date.now() + expMs).toISOString() } })
    return res.status
  }

  async revokeDevice(roomId: string, ownerSecret: string, deviceId: string): Promise<number> {
    const res = await this.fetch(`/rooms/${roomId}/devices/${deviceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${ownerSecret}` } })
    return res.status
  }

  /** Opens a WebSocket to the room; the caller sends the `auth` frame. */
  async connect(roomId: string, init: { path?: string; headers?: Record<string, string>; origin?: string } = {}): Promise<Client> {
    const res = await this.mf.dispatchFetch(`${init.origin ?? ORIGIN}${init.path ?? `/rooms/${roomId}/ws`}`, { headers: { upgrade: 'websocket', ...init.headers } })
    if (!res.webSocket) throw new Error(`connect: ${res.status} ${await res.text()}`)
    return new Client(res.webSocket)
  }

  /** Opens and authenticates in one go; the returned client has not consumed any message yet. */
  async connectAs(roomId: string, auth: Extract<RelayClientFrame, { auth: unknown }>['auth']): Promise<Client> {
    const client = await this.connect(roomId)
    client.send({ auth })
    return client
  }

  async dispose(): Promise<void> {
    await this.mf.dispose()
  }
}

/** A room with its owner, one registered device and the frames to talk through it. */
export interface Fixture {
  relay: Relay
  roomId: string
  ownerSecret: string
  deviceId: string
  relayToken: string
  desktop: () => Promise<Client>
  phone: () => Promise<Client>
}

export async function fixture(relay: Relay): Promise<Fixture> {
  const ownerSecret = randomId('owner')
  const roomId = await relay.createRoom(ownerSecret)
  const deviceId = randomId('device')
  const relayToken = randomId('token')
  const status = await relay.registerDevice(roomId, ownerSecret, deviceId, relayToken)
  if (status !== 201) throw new Error(`registerDevice: ${status}`)
  return {
    relay,
    roomId,
    ownerSecret,
    deviceId,
    relayToken,
    desktop: () => relay.connectAs(roomId, { room: roomId, owner: ownerSecret }),
    phone: () => relay.connectAs(roomId, { room: roomId, device: deviceId, token: relayToken })
  }
}

export function frame(to: string, ref: string, extra: Partial<RelayFrame> = {}): RelayFrame {
  return { to, ref, nonce: nonce(), ct: ciphertext(), ...extra }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
