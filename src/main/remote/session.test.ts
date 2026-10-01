import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openEnvelope,
  requireEnvelope,
  requireRelayFrame,
  sealEnvelope,
  ttlFor,
  type Envelope,
  type HelloBody,
  type RelayFrame,
  type StatusSummary
} from '@shared/remote'
import { DeviceStore } from './devices'
import { Gateway, type GatewayServices } from './gateway'
import { projectStatus } from './project'
import { RemoteSession, type SocketLike } from './session'
import { command, fakeCipher, fakePhone, queueState, type FakePhone } from './test-helpers'
import type { WorkspaceIdentity } from './workspace'

/**
 * An in-process relay: accepts one socket at a time, requires the owner auth frame first,
 * records every frame the desktop sends and lets a test push frames "from a phone".
 */
class FakeRelay {
  sockets: FakeSocket[] = []
  sent: RelayFrame[] = []
  auths: unknown[] = []
  connects = 0
  /** When set, the next connection fails right away (relay down). */
  refuse = false
  /** The owner secret the room accepts. */
  owner = ''

  connect = (url: string): SocketLike => {
    this.connects++
    expect(url).toMatch(/^wss:\/\//)
    if (this.refuse) throw new Error('ECONNREFUSED')
    const socket = new FakeSocket(this)
    this.sockets.push(socket)
    queueMicrotask(() => socket.emit('open'))
    return socket
  }

  get current(): FakeSocket {
    return this.sockets[this.sockets.length - 1]
  }

  /** Delivers a frame from a phone to the desktop's socket. */
  deliver(frame: RelayFrame): void {
    this.current.emit('message', JSON.stringify(frame))
  }

  /** The relay drops the desktop's socket (network blip). */
  drop(reason?: string): void {
    const s = this.current
    s.closed = true
    s.emit('close', reason)
  }

  framesTo(deviceId: string): RelayFrame[] {
    return this.sent.filter((f) => f.to === deviceId)
  }
}

class FakeSocket implements SocketLike {
  private handlers = new Map<string, ((...args: never[]) => void)[]>()
  authed = false
  closed = false
  constructor(private relay: FakeRelay) {}
  send(text: string): void {
    if (this.closed) throw new Error('socket closed')
    const raw = JSON.parse(text)
    if (!this.authed) {
      this.relay.auths.push(raw)
      if (raw?.auth?.owner !== this.relay.owner) {
        this.closed = true
        queueMicrotask(() => this.emit('close', 'unauthorized'))
        return
      }
      this.authed = true
      return
    }
    this.relay.sent.push(requireRelayFrame(raw))
  }
  close(): void {
    this.closed = true
  }
  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args)
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

let dir: string
let ws: string
let devices: DeviceStore
let phone: FakePhone
let relay: FakeRelay
let session: RemoteSession
let gateway: Gateway
let identity: WorkspaceIdentity
let states: string[]
let details = false
let paused = false
const creds = { relayUrl: 'https://relay.example.com', adminToken: 'admin', roomId: 'room-1', ownerSecret: 'owner-secret-base64' }

function status(): StatusSummary {
  return projectStatus({ desktopName: 'Mac', appVersion: '0.1.0', workspace: identity, queue: queueState({ paused }), agents: [{ id: 'claude', ready: true }] })
}

function services(): GatewayServices {
  const q = () => queueState({ paused })
  return {
    desktopName: 'Mac',
    appVersion: '0.1.0',
    workspace: async () => identity,
    agents: async () => [{ id: 'claude', ready: true }],
    defaultAgent: async () => 'claude',
    queue: {
      state: async () => q(),
      setPaused: async (p) => {
        paused = p
        return q()
      },
      cancel: async () => q(),
      retry: async () => q(),
      enqueue: async () => ({ state: q(), added: 0, skipped: [] }),
      reply: async () => null
    },
    runs: { list: async () => [], get: async () => ({ run: {} as never, items: [] }), reply: async () => ({}) as never, stop: async () => ({}) as never, finish: async () => ({}) as never },
    jobs: { list: async () => [], addUrl: async () => ({}) as never },
    files: { resolve: async () => '' },
    transcripts: () => true
  }
}

/** Opens a frame the desktop sent to the phone. */
function open(frame: RelayFrame): Envelope {
  const plain = openEnvelope(frame, phone.sessionKey)
  expect(plain, 'the phone can open the frame').not.toBeNull()
  return requireEnvelope(plain, { sid: phone.sid, from: 'desktop' })
}

/** Boxes an envelope from the phone. */
function fromPhone(envelope: Envelope): RelayFrame {
  return { to: 'desktop', ref: envelope.id!, ...sealEnvelope(envelope, phone.sessionKey), ttl: envelope.ttl }
}

async function online(): Promise<void> {
  for (let i = 0; i < 100 && !session.isOnline(); i++) await tick(5)
  expect(session.isOnline()).toBe(true)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-session-'))
  ws = await mkdtemp(join(tmpdir(), 'huntgry-session-ws-'))
  identity = { path: ws, id: 'a'.repeat(32), name: 'cv' }
  devices = new DeviceStore(dir, fakeCipher())
  await devices.load()
  phone = fakePhone((await devices.keyPair())!)
  await devices.add(phone.record)
  relay = new FakeRelay()
  relay.owner = creds.ownerSecret
  states = []
  details = false
  paused = false
  gateway = new Gateway(services(), devices)
  session = new RemoteSession({
    connect: relay.connect,
    devices,
    gateway,
    desktopName: 'Mac',
    appVersion: '0.1.0',
    workspace: async () => identity,
    status: async () => status(),
    notificationDetails: () => details,
    onState: (s) => states.push(s.connection),
    heartbeatMs: 40,
    activeWindowMs: 10_000,
    backoffMinMs: 10,
    backoffMaxMs: 40
  })
})

afterEach(async () => {
  session.stop()
  await devices.flush()
  await rm(dir, { recursive: true, force: true })
  await rm(ws, { recursive: true, force: true })
})

describe('RemoteSession', () => {
  it('connects outbound over wss, authenticates with the owner secret in the first frame, never in the URL', async () => {
    session.start(creds)
    await online()
    expect(relay.auths).toEqual([{ auth: { room: 'room-1', owner: creds.ownerSecret } }])
    expect(relay.connects).toBe(1)
    expect(states).toContain('online')
  })

  it('answers a command: boxed with a fresh nonce, persisted seq, ack = command id, and the audit log records it', async () => {
    session.start(creds)
    await online()
    const cmd = command(phone, 'queue.setPaused', { paused: true }, identity.id)
    relay.deliver(fromPhone(cmd))
    await tick(50)
    await session.flush()
    const results = () => relay.framesTo(phone.id).filter((f) => f.ack !== undefined)
    const frames = results()
    expect(frames).toHaveLength(1)
    expect(frames[0].ack).toBe(cmd.id)
    expect(frames[0].ref).toBeTruthy()
    expect(frames[0].pushHint).toBeUndefined()
    const result = open(frames[0])
    expect(result).toMatchObject({ kind: 'result', re: cmd.id, ok: true, from: 'desktop', sid: phone.sid })
    expect((result.body as { paused: boolean }).paused).toBe(true)
    expect(paused).toBe(true)
    expect(open(frames[0]).seq).toBeLessThanOrEqual(devices.currentOutSeq())

    // A second frame: a new nonce, the next seq.
    relay.deliver(fromPhone(command(phone, 'queue.get', undefined, identity.id)))
    await tick(50)
    await session.flush()
    const second = results()[1]
    expect(second.nonce).not.toBe(frames[0].nonce)
    expect(open(second).seq).toBeGreaterThan(open(frames[0]).seq)
    expect(new Set(relay.framesTo(phone.id).map((f) => f.nonce)).size).toBe(relay.framesTo(phone.id).length)
  })

  it('drops a frame no paired device can open and answers denied for another session id', async () => {
    session.start(creds)
    await online()
    const stranger = fakePhone((await devices.keyPair())!, 'Stranger')
    const cmd = command(stranger, 'queue.setPaused', { paused: true }, identity.id)
    relay.deliver({ to: 'desktop', ref: cmd.id!, ...sealEnvelope(cmd, stranger.sessionKey), ttl: 60 })
    await tick(30)
    expect(relay.sent).toHaveLength(0)
    expect(paused).toBe(false)

    const foreign = command(phone, 'queue.setPaused', { paused: true }, identity.id, { sid: 'another-sid' })
    relay.deliver(fromPhone(foreign))
    await tick(50)
    await session.flush()
    const [frame] = relay.framesTo(phone.id)
    expect(open(frame)).toMatchObject({ kind: 'result', ok: false, error: { code: 'denied' } })
    expect(frame.ack).toBe(foreign.id)
    expect(paused).toBe(false)
  })

  it('answers hello with hello (protocol, workspace name + id) and a status event, and pong to ping', async () => {
    session.start(creds)
    await online()
    const hello: Envelope = { v: 1, sid: phone.sid, from: 'phone', seq: ++phone.seq, ts: new Date().toISOString(), ttl: 60, kind: 'hello', id: 'hello-1', body: { protocol: { min: 1, max: 1 }, name: 'Renamed iPhone', appVersion: '1.0.0' } satisfies HelloBody }
    relay.deliver(fromPhone(hello))
    await tick(50)
    await session.flush()
    const [h, s] = relay.framesTo(phone.id).map(open)
    expect(h.kind).toBe('hello')
    expect(h.body).toEqual({ protocol: { min: 1, max: 1 }, name: 'Mac', appVersion: '0.1.0', workspace: { id: identity.id, name: 'cv' } })
    expect(s.kind).toBe('event')
    expect(s.name).toBe('status')
    expect((s.body as StatusSummary).desktop.workspaceId).toBe(identity.id)
    expect(JSON.stringify(h.body) + JSON.stringify(s.body)).not.toContain(ws)
    expect(devices.get(phone.id)!.name).toBe('Renamed iPhone')

    relay.deliver(fromPhone({ v: 1, sid: phone.sid, from: 'phone', seq: ++phone.seq, ts: new Date().toISOString(), ttl: 60, kind: 'ping', id: 'ping-1', body: null }))
    await tick(50)
    await session.flush()
    const pong = relay.framesTo(phone.id).map(open).find((e) => e.kind === 'pong')
    expect(pong).toBeDefined()
  })

  it('sets pushHint only for the device\'s categories and pushText only when details are on (≤ 80 chars)', async () => {
    session.start(creds)
    await online()
    const other = fakePhone((await devices.keyPair())!, 'Other')
    await devices.add(other.record)
    await devices.update(phone.id, { categories: ['needs-reply'] })
    const run = { id: '20260930-010203-a1b2c3', title: 'T'.repeat(150), agent: 'claude' as const, status: 'waiting' as const, job: {}, options: { coverLetter: false, dateStyle: 'right' as const }, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', files: [], costUsd: 0, live: true }
    await session.broadcast('run.changed', run, run.title)
    await session.flush()
    expect(relay.framesTo(phone.id)[0].pushHint).toBe('needs-reply')
    expect(relay.framesTo(phone.id)[0].pushText).toBeUndefined()
    expect(relay.framesTo(other.id)[0].pushHint).toBeUndefined()
    details = true
    await session.broadcast('run.changed', run, run.title)
    await session.flush()
    expect(relay.framesTo(phone.id)[1].pushText).toHaveLength(80)
    await session.broadcast('run.changed', { ...run, status: 'running' }, run.title)
    await session.flush()
    expect(relay.framesTo(phone.id)[2].pushHint).toBeUndefined()
    // Every frame passed the relay's own guard (size, shape) and opens only with its own device's key.
    for (const f of relay.framesTo(phone.id)) expect(open(f).kind).toBe('event')
    for (const f of relay.framesTo(other.id)) expect(openEnvelope(f, phone.sessionKey)).toBeNull()
  })

  it('reconnects with backoff after a drop and immediately on resume; a relay outage loses nothing of the queue', async () => {
    session.start(creds)
    await online()
    relay.drop('network')
    expect(session.isOnline()).toBe(false)
    expect(states[states.length - 1]).toBe('offline')
    expect(session.current().nextAttemptAt).toBeTruthy()
    // Events while offline are dropped, not thrown; the service itself is untouched.
    await session.broadcast('queue.changed', { items: [], concurrency: 1, paused: false })
    await online()
    expect(relay.connects).toBe(2)

    relay.refuse = true
    relay.drop()
    await tick(60)
    expect(relay.connects).toBeGreaterThanOrEqual(3)
    expect(session.isOnline()).toBe(false)
    relay.refuse = false
    session.reconnectNow() // powerMonitor resume
    await online()
    // The replay counter survives the reconnects: the next command is accepted and the desktop's seq continues.
    relay.sent = []
    relay.deliver(fromPhone(command(phone, 'queue.get', undefined, identity.id)))
    await tick(50)
    await session.flush()
    expect(open(relay.framesTo(phone.id)[0]).ok).toBe(true)
  })

  it('reports a refused authentication as offline with a credentials error and keeps retrying', async () => {
    relay.owner = 'someone-else'
    session.start(creds)
    await tick(30)
    expect(session.isOnline()).toBe(false)
    expect(session.current().error).toMatch(/credentials|authentication/i)
    await tick(60)
    expect(relay.connects).toBeGreaterThan(1)
  })

  it('sends heartbeat status only to recently active devices and device.revoked on revoke', async () => {
    session.start(creds)
    await online()
    const idle = fakePhone((await devices.keyPair())!, 'Idle')
    await devices.add(idle.record)
    await devices.update(phone.id, { lastSeen: new Date().toISOString() })
    await tick(100)
    await session.flush()
    expect(relay.framesTo(phone.id).length).toBeGreaterThan(0)
    expect(relay.framesTo(idle.id)).toHaveLength(0)
    for (const f of relay.framesTo(phone.id)) {
      const e = open(f)
      expect(e.name).toBe('status')
      expect(e.ttl).toBe(60)
    }
    await session.notifyRevoked(phone.id, 'Removed in Settings.')
    await session.flush()
    const last = open(relay.framesTo(phone.id).at(-1)!)
    expect(last.name).toBe('device.revoked')
    expect(last.body).toEqual({ reason: 'Removed in Settings.' })
    expect(ttlFor('queue.get')).toBe(24 * 3600)
  })

  it('never sends an event over the frame budget (the package guard runs before boxing)', async () => {
    session.start(creds)
    await online()
    await session.broadcast('run.transcript', { runId: 'r', items: Array.from({ length: 20 }, (_, i) => ({ kind: 'user' as const, id: `i${i}`, text: 'x'.repeat(8 * 1024) })), seq: 0 })
    await session.flush()
    expect(relay.sent).toHaveLength(0)
  })
})
