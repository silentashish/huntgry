import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// The phone side uses only the protocol package, as the #38 app does.
import {
  deriveSessionKey,
  generateKeyPair,
  openEnvelope,
  openPairReply,
  parsePairingUrl,
  randomBytes,
  requireEnvelope,
  sealEnvelope,
  sealPairMessage,
  toBase64,
  type Envelope,
  type PairOk,
  type RelayFrame,
  type StatusSummary
} from '@shared/remote'
import { DeviceStore } from './devices'
import { Gateway, type GatewayServices } from './gateway'
import { PairingManager } from './pairing'
import { projectStatus } from './project'
import { RemoteSession, type SocketLike } from './session'
import { fakeCipher, queueState } from './test-helpers'
import type { WorkspaceIdentity } from './workspace'

/**
 * End to end over an in-process relay (#37): a phone scans the QR, sends `pair.hello` on a
 * pairing socket, the owner approves on the desktop, the phone gets `pair.ok`, acks, reconnects
 * as the new device with its relay token, sends `hello` and gets `hello` + `status` back.
 */

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

type Identity = { kind: 'desktop' } | { kind: 'pairing'; id: string } | { kind: 'device'; id: string }

/** The relay's rules that matter here: first-frame auth per kind, routing by `to`, clear acks consumed. */
class MiniRelay {
  readonly room = 'room-1'
  readonly owner = 'owner-secret'
  pairings = new Map<string, number>()
  devices = new Map<string, string>()
  live = new Map<string, Socket>()
  acks: string[] = []
  refused: string[] = []

  /** The desktop session's `connect`. */
  connect = (url: string): SocketLike => {
    expect(url).toBe('wss://relay.example.com/ws')
    return this.open()
  }

  open(): Socket {
    const socket = new Socket(this)
    queueMicrotask(() => socket.emit('open'))
    return socket
  }

  key(who: Identity): string {
    return who.kind === 'desktop' ? 'desktop' : `${who.kind}:${who.id}`
  }

  authenticate(raw: unknown): Identity | null {
    const auth = (raw as { auth?: Record<string, string> })?.auth
    if (!auth || auth.room !== this.room) return null
    if (auth.owner !== undefined) return auth.owner === this.owner ? { kind: 'desktop' } : null
    if (auth.pairing !== undefined) return (this.pairings.get(auth.pairing) ?? 0) > Date.now() ? { kind: 'pairing', id: auth.pairing } : null
    if (auth.device !== undefined) return this.devices.get(auth.device) === sha256(auth.token ?? '') ? { kind: 'device', id: auth.device } : null
    return null
  }

  route(from: Identity, frame: RelayFrame): void {
    const forwarded: RelayFrame = { to: frame.to, ref: frame.ref, nonce: frame.nonce, ct: frame.ct, ttl: frame.ttl }
    if (from.kind !== 'desktop') {
      expect(frame.to).toBe('desktop')
      this.deliver('desktop', forwarded)
      return
    }
    const target = this.devices.has(frame.to) ? `device:${frame.to}` : `pairing:${frame.to}`
    this.deliver(target, forwarded)
  }

  deliver(key: string, frame: RelayFrame): void {
    const socket = this.live.get(key)
    if (socket) queueMicrotask(() => socket.emit('message', JSON.stringify(frame)))
  }
}

class Socket implements SocketLike {
  private handlers = new Map<string, ((...args: never[]) => void)[]>()
  who: Identity | null = null
  closed = false
  inbox: RelayFrame[] = []
  constructor(private relay: MiniRelay) {}
  send(text: string): void {
    if (this.closed) throw new Error('socket closed')
    const raw = JSON.parse(text)
    if (!this.who) {
      this.who = this.relay.authenticate(raw)
      if (!this.who) {
        this.relay.refused.push(text)
        this.close()
        return
      }
      this.relay.live.set(this.relay.key(this.who), this)
      return
    }
    if ('ack' in raw && !('ct' in raw)) {
      this.relay.acks.push(raw.ack)
      return
    }
    this.relay.route(this.who, raw as RelayFrame)
  }
  close(): void {
    this.closed = true
    if (this.who && this.relay.live.get(this.relay.key(this.who)) === this) this.relay.live.delete(this.relay.key(this.who))
  }
  on(event: string, cb: (...args: never[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb])
  }
  emit(event: string, ...args: unknown[]): void {
    if (event === 'message') this.inbox.push(JSON.parse(args[0] as string))
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args)
  }
}

async function waitFor<T>(get: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = get()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

let dir: string
let devices: DeviceStore
let relay: MiniRelay
let session: RemoteSession
let pairing: PairingManager
let qrText: string
const identity: WorkspaceIdentity = { path: '', id: 'b'.repeat(32), name: 'cv' }

const status = (): StatusSummary =>
  projectStatus({ desktopName: 'Mac', appVersion: '0.1.0', workspace: identity, queue: queueState(), agents: [{ id: 'claude', ready: true }] })

function services(): GatewayServices {
  return {
    desktopName: 'Mac',
    appVersion: '0.1.0',
    workspace: async () => identity,
    agents: async () => [{ id: 'claude', ready: true }],
    defaultAgent: async () => 'claude',
    queue: { state: async () => queueState(), setPaused: async () => queueState(), cancel: async () => queueState(), retry: async () => queueState(), enqueue: async () => ({ state: queueState(), added: 0, skipped: [] }), reply: async () => null },
    runs: { list: async () => [], get: async () => ({ run: {} as never, items: [] }), reply: async () => ({}) as never, stop: async () => ({}) as never, finish: async () => ({}) as never },
    jobs: { list: async () => [], addUrl: async () => ({}) as never },
    files: { resolve: async () => '' },
    transcripts: () => true
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-pair-e2e-'))
  identity.path = await mkdtemp(join(tmpdir(), 'huntgry-pair-e2e-ws-'))
  devices = new DeviceStore(dir, fakeCipher())
  await devices.load()
  relay = new MiniRelay()
  const gateway = new Gateway(services(), devices)
  session = new RemoteSession({
    connect: relay.connect,
    devices,
    gateway,
    desktopName: 'Mac',
    appVersion: '0.1.0',
    workspace: async () => identity,
    status: async () => status(),
    notificationDetails: () => false,
    pairing: { receive: (frame) => pairing.receive(frame) },
    backoffMinMs: 10,
    backoffMaxMs: 40
  })
  pairing = new PairingManager({
    devices,
    relay: () => ({ relayUrl: 'https://relay.example.com', roomId: relay.room }),
    // The relay's HTTP side, as `POST /rooms/{room}/pairings` and `POST …/devices` store them.
    registerPairing: async (pairingId, exp) => void relay.pairings.set(pairingId, Date.parse(exp)),
    registerDevice: async (deviceId, tokenHash) => void relay.devices.set(deviceId, tokenHash),
    unregisterDevice: async (deviceId) => void relay.devices.delete(deviceId),
    send: (frame) => session.sendFrame(frame),
    ack: (ref) => session.ack(ref),
    online: () => session.isOnline(),
    desktopName: 'Mac',
    renderQr: (text) => {
      qrText = text
      return 'data:image/svg+xml;base64,'
    }
  })
  session.start({ relayUrl: 'https://relay.example.com', adminToken: 'admin', roomId: relay.room, ownerSecret: relay.owner })
  await waitFor(() => session.isOnline())
})

afterEach(async () => {
  pairing.cancelAll()
  session.stop()
  await devices.flush()
  await rm(dir, { recursive: true, force: true })
  await rm(identity.path, { recursive: true, force: true })
})

describe('pairing end to end', () => {
  it('scan → hello → Approve → pair.ok → reconnect as the device → hello + status', async () => {
    // Settings: "Pair a phone".
    await pairing.start()

    // The phone scans the QR and opens a pairing socket.
    const invite = parsePairingUrl(qrText)
    const phoneKeys = generateKeyPair()
    const pairSocket = relay.open()
    await waitFor(() => pairSocket.who === null && !pairSocket.closed)
    pairSocket.send(JSON.stringify({ auth: { room: invite.room, pairing: invite.pairing } }))
    expect(pairSocket.who).toEqual({ kind: 'pairing', id: invite.pairing })
    const helloRef = randomUUID()
    pairSocket.send(
      JSON.stringify({
        to: 'desktop',
        ref: helloRef,
        ...sealPairMessage({ pair: 'hello', hello: { devicePub: toBase64(phoneKeys.publicKey), deviceName: 'Test iPhone', appVersion: '1.0.0', protocol: { min: 1, max: 1 } } }, invite.secret),
        ttl: 120
      })
    )

    // The desktop shows "Pair 'Test iPhone'?"; the owner approves.
    const request = await waitFor(() => pairing.list().find((p) => p.status === 'scanned'))
    expect(request.deviceName).toBe('Test iPhone')
    expect(relay.acks).toContain(helloRef)
    expect(relay.devices.size).toBe(0)
    await pairing.approve(request.id)

    // The phone gets pair.ok on its pairing socket, acks it and closes.
    const okFrame = await waitFor(() => pairSocket.inbox[0])
    const sessionKey = deriveSessionKey(invite.desktopPublicKey, phoneKeys.secretKey)
    const message = openPairReply(okFrame, { secret: invite.secret, sessionKey })
    expect(message?.pair).toBe('ok')
    const ok = (message as { ok: PairOk }).ok
    pairSocket.send(JSON.stringify({ ack: okFrame.ref }))
    pairSocket.close()
    expect(relay.acks).toContain(okFrame.ref)

    // Reconnect as the device with the relay token, then hello under the agreed sid.
    const deviceSocket = relay.open()
    await new Promise((r) => setTimeout(r, 0))
    deviceSocket.send(JSON.stringify({ auth: { room: invite.room, device: ok.deviceId, token: ok.relayToken } }))
    expect(deviceSocket.who).toEqual({ kind: 'device', id: ok.deviceId })
    const hello: Envelope = { v: 1, sid: ok.sid, from: 'phone', seq: 1, ts: new Date().toISOString(), ttl: 60, kind: 'hello', id: randomUUID(), body: { protocol: { min: 1, max: 1 }, name: 'Test iPhone', appVersion: '1.0.0' } }
    deviceSocket.send(JSON.stringify({ to: 'desktop', ref: hello.id, ...sealEnvelope(hello, sessionKey), ttl: 60 }))

    await waitFor(() => deviceSocket.inbox.length >= 2)
    const replies = deviceSocket.inbox.map((f) => requireEnvelope(openEnvelope(f, sessionKey), { sid: ok.sid, from: 'desktop' }))
    expect(replies[0]).toMatchObject({ kind: 'hello', body: { name: 'Mac', workspace: { id: identity.id, name: 'cv' } } })
    expect(replies[1]).toMatchObject({ kind: 'event', name: 'status' })
    expect(devices.get(ok.deviceId)).toMatchObject({ name: 'Test iPhone', lastSeq: 1, needsRepair: false })
    expect(devices.get(ok.deviceId)!.lastSeen).toBeTruthy()
  })

  it('Deny: the phone is told and its token never exists on the relay', async () => {
    await pairing.start()
    const invite = parsePairingUrl(qrText)
    const pairSocket = relay.open()
    await new Promise((r) => setTimeout(r, 0))
    pairSocket.send(JSON.stringify({ auth: { room: invite.room, pairing: invite.pairing } }))
    pairSocket.send(
      JSON.stringify({
        to: 'desktop',
        ref: randomUUID(),
        ...sealPairMessage({ pair: 'hello', hello: { devicePub: toBase64(generateKeyPair().publicKey), deviceName: 'Stranger', appVersion: '1.0.0', protocol: { min: 1, max: 1 } } }, invite.secret),
        ttl: 120
      })
    )
    const request = await waitFor(() => pairing.list().find((p) => p.status === 'scanned'))
    await pairing.deny(request.id)
    const denied = await waitFor(() => pairSocket.inbox[0])
    expect(openPairReply(denied, { secret: invite.secret, sessionKey: randomBytes(32) })).toEqual({ pair: 'denied', reason: 'denied' })
    expect(relay.devices.size).toBe(0)
    expect(devices.list()).toEqual([])
  })
})
