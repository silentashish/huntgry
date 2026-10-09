/**
 * Test doubles for the client modules: a scriptable WebSocket, a manual clock and a fake
 * desktop that seals envelopes with the pinned fixture session key. Imported by tests only.
 */

import {
  fromHex,
  openEnvelope,
  sealEnvelope,
  toBase64,
  type Envelope,
  type RelayFrame
} from '@huntgry/remote-protocol'
import fixture from '../../../src/shared/remote/crypto.fixture.json'
import { uuid } from './ids'
import { MemoryStorage, type Clock, type SocketLike } from './platform'
import { Vault, type Pairing } from './vault'

export { fixture }

export const SESSION_KEY = fromHex(fixture.sessionKey)

export const PAIRING: Pairing = {
  relay: 'https://relay.example.com',
  room: 'room-1',
  deviceId: 'device-1',
  relayToken: 'ab'.repeat(32),
  desktopPublicKey: fixture.desktopPublicKey,
  sessionKey: toBase64(SESSION_KEY),
  sid: 'sid-1',
  desktopName: "Ashish's MacBook Pro",
  deviceName: "Ashish's iPhone",
  pairedAt: '2026-10-09T12:00:00.000Z',
  categories: ['needs-reply', 'usage-limit', 'pipeline-finished', 'needs-review', 'failed']
}

export const NOW = Date.parse('2026-10-09T12:00:00.000Z')

export class FakeSocket implements SocketLike {
  readyState = 0
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  /** Called at the moment of each send (to inspect storage then). */
  onSend: ((text: string) => void) | null = null

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open')
    this.onSend?.(data)
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.closed = { code, reason }
  }

  // ── driven by the test ──
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) })
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  json(i: number): Record<string, unknown> {
    return JSON.parse(this.sent[i]) as Record<string, unknown>
  }

  /** Every boxed frame sent, opened with the session key. */
  envelopes(key: Uint8Array = SESSION_KEY): Envelope[] {
    return this.sent
      .map((t) => JSON.parse(t) as Record<string, unknown>)
      .filter((f) => 'ct' in f)
      .map((f) => openEnvelope(f as unknown as RelayFrame, key) as Envelope)
  }

  frames(): RelayFrame[] {
    return this.sent.map((t) => JSON.parse(t) as Record<string, unknown>).filter((f) => 'ct' in f) as unknown as RelayFrame[]
  }

  acks(): string[] {
    const out: string[] = []
    for (const t of this.sent) {
      const f = JSON.parse(t) as Record<string, unknown>
      if (typeof f.ack === 'string') out.push(f.ack)
    }
    return out
  }
}

export class Sockets {
  readonly all: FakeSocket[] = []
  factory = (url: string): FakeSocket => {
    const s = new FakeSocket(url)
    this.all.push(s)
    return s
  }
  get last(): FakeSocket {
    return this.all[this.all.length - 1]
  }
}

export class FakeClock implements Clock {
  private timers: { at: number; fn: () => void; id: number }[] = []
  private seq = 0
  constructor(public t = NOW) {}
  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }
  /** Moves time forward, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at)
      const next = this.timers[0]
      if (!next || next.at > end) break
      this.timers.shift()
      this.t = next.at
      next.fn()
      await settle()
    }
    this.t = end
    await settle()
  }
  pending(): number {
    return this.timers.length
  }
}

/** Lets queued promises (storage writes, the send loop) run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

export async function pairedVault(storage = new MemoryStorage()): Promise<{ storage: MemoryStorage; vault: Vault }> {
  const vault = new Vault(storage)
  await vault.savePairing(PAIRING)
  return { storage, vault }
}

/** The desktop side: seals envelopes for this device with the session key, with its own counter. */
export class FakeDesktop {
  seq = 100
  constructor(
    private readonly clock: Clock,
    private readonly key: Uint8Array = SESSION_KEY,
    private readonly sid = PAIRING.sid
  ) {}

  frame(env: Partial<Envelope> & Pick<Envelope, 'kind' | 'body'>, opts: { seq?: number; ref?: string; ack?: string } = {}): RelayFrame {
    const envelope: Envelope = {
      v: 1,
      sid: this.sid,
      from: 'desktop',
      seq: opts.seq ?? ++this.seq,
      ts: new Date(this.clock.now()).toISOString(),
      ttl: 60,
      id: uuid(),
      ...env
    }
    const frame: RelayFrame = { to: PAIRING.deviceId, ref: opts.ref ?? envelope.id!, ...sealEnvelope(envelope, this.key), ttl: envelope.ttl }
    if (opts.ack) frame.ack = opts.ack
    return frame
  }

  result(re: string, body: unknown, opts: { seq?: number; ok?: boolean; error?: Envelope['error'] } = {}): RelayFrame {
    const ok = opts.ok ?? true
    const env: Partial<Envelope> & Pick<Envelope, 'kind' | 'body'> = { kind: 'result', re, ok, body: ok ? body : null }
    if (!ok) env.error = opts.error ?? { code: 'failed', message: 'failed' }
    return this.frame(env, { seq: opts.seq, ack: re })
  }

  event(name: string, body: unknown, opts: { seq?: number } = {}): RelayFrame {
    return this.frame({ kind: 'event', name, body }, opts)
  }
}

export const presence = (online = true) => ({ presence: online ? 'online' : 'offline', since: new Date(NOW - 60_000).toISOString(), queued: 0 })

export const STATUS = {
  desktop: { name: "Ashish's MacBook Pro", appVersion: '0.1.0', workspaceName: 'The den', workspaceId: 'a'.repeat(32) },
  queue: { active: 3, needsReply: 1, failed: 0, paused: false },
  pipeline: null,
  review: { unreviewed: 0 },
  agents: [
    { id: 'claude', ready: true },
    { id: 'codex', ready: true }
  ]
}
