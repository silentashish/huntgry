import {
  PAIRING_TTL_SECONDS,
  deriveSessionKey,
  fromBase64,
  fromHex,
  openPairMessage,
  pairingUrl,
  sealPairMessage,
  toHex,
  type PairMessage,
  type RelayFrame
} from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { uuid } from './ids'
import { PairingError, PairingFlow, type PairingStep } from './pairing'
import { MemoryStorage } from './platform'
import { FakeClock, NOW, Sockets, fixture, settle } from './test-helpers'
import { Vault, VAULT_KEYS } from './vault'

const SECRET = fromHex(fixture.pairingSecret)
const DESKTOP_PUB = fromHex(fixture.desktopPublicKey)
const DESKTOP_SECRET = fromHex(fixture.desktopSecretKey)

const qr = (over: { relay?: string; exp?: number } = {}) =>
  pairingUrl({ v: 1, relay: over.relay ?? 'https://relay.example.com', room: 'room-1', pairing: 'pairing-1', desktopPublicKey: DESKTOP_PUB, secret: SECRET, exp: over.exp ?? NOW / 1000 + PAIRING_TTL_SECONDS })

const OK = { deviceId: 'device-9', relayToken: 'cd'.repeat(32), desktopName: "Ashish's MacBook Pro", protocol: { min: 1, max: 1 }, sid: 'sid-9' }

function setup() {
  const clock = new FakeClock()
  const sockets = new Sockets()
  const storage = new MemoryStorage()
  const vault = new Vault(storage)
  const steps: PairingStep['step'][] = []
  const full: PairingStep[] = []
  const flow = new PairingFlow({
    vault,
    socket: sockets.factory,
    clock,
    appVersion: '0.1.0',
    deviceName: "Ashish's iPhone",
    onStep: (s) => {
      steps.push(s.step)
      full.push(s)
    }
  })
  const sealed = (message: PairMessage, key: Uint8Array): RelayFrame => ({ to: 'pairing-1', ref: uuid(), ...sealPairMessage(message, key), ttl: PAIRING_TTL_SECONDS })
  /** The desktop's side of the session key, from the hello's device public key. */
  const desktopSessionKey = async () => deriveSessionKey((await vault.loadIdentity())!.publicKey, DESKTOP_SECRET)
  /** As the desktop answers: ok under the session key, denied under S. */
  const fromDesktop = async (message: PairMessage): Promise<RelayFrame> => sealed(message, message.pair === 'ok' ? await desktopSessionKey() : SECRET)
  return { clock, sockets, storage, vault, steps, full, flow, fromDesktop, sealed, desktopSessionKey }
}

async function untilHello(t: ReturnType<typeof setup>, desktopOnline = true) {
  await settle()
  t.sockets.last.open()
  t.sockets.last.receive({ presence: desktopOnline ? 'online' : 'offline', since: new Date(NOW).toISOString(), queued: 0 })
  await settle()
}

describe('pairing flow', () => {
  it('authenticates with the pairing id and sends pair.hello sealed with the QR secret', async () => {
    const t = setup()
    void t.flow.start(qr()).catch(() => undefined)
    await untilHello(t)
    const socket = t.sockets.last
    expect(socket.url).toBe('wss://relay.example.com/ws')
    expect(socket.json(0)).toEqual({ auth: { room: 'room-1', pairing: 'pairing-1' } })
    const frame = socket.json(1) as unknown as RelayFrame
    expect(frame).toMatchObject({ to: 'desktop', ttl: PAIRING_TTL_SECONDS })
    const hello = openPairMessage(frame, SECRET)
    expect(hello?.pair).toBe('hello')
    // The device public key in hello is the identity just stored in the secure store.
    const identity = await t.vault.loadIdentity()
    expect(hello).toEqual({ pair: 'hello', hello: { devicePub: Buffer.from(identity!.publicKey).toString('base64'), deviceName: "Ashish's iPhone", appVersion: '0.1.0', protocol: { min: 1, max: 1 } } })
    expect(t.steps).toEqual(['connecting', 'waiting'])
    t.flow.cancel()
  })

  it('refuses an ok sealed with the QR secret and a denial sealed with the session key', async () => {
    const t = setup()
    void t.flow.start(qr()).catch(() => undefined)
    await untilHello(t)
    // Anyone who saw the QR knows S: an ok under S must not hand them the pairing.
    t.sockets.last.receive(t.sealed({ pair: 'ok', ok: OK }, SECRET))
    t.sockets.last.receive(t.sealed({ pair: 'denied', reason: 'denied' }, await t.desktopSessionKey()))
    await settle()
    expect(t.steps.at(-1)).toBe('waiting')
    expect(await t.vault.loadPairing()).toBeNull()
    expect(t.sockets.last.acks()).toEqual([])
    t.flow.cancel()
  })

  it('stores the pairing and the derived session key on pair.ok, acks it and closes', async () => {
    const t = setup()
    const done = t.flow.start(qr())
    await untilHello(t)
    const ok = await t.fromDesktop({ pair: 'ok', ok: OK })
    t.sockets.last.receive(ok)
    const pairing = await done
    await settle()
    expect(t.sockets.last.json(2)).toEqual({ ack: ok.ref })
    expect(t.sockets.last.closed).not.toBeNull()
    const identity = (await t.vault.loadIdentity())!
    // Both ends derive the same key: phone (desktopPub, devicePriv) = desktop (devicePub, desktopPriv).
    expect(toHex(fromBase64(pairing.sessionKey))).toBe(toHex(deriveSessionKey(identity.publicKey, DESKTOP_SECRET)))
    expect(pairing).toMatchObject({ relay: 'https://relay.example.com', room: 'room-1', deviceId: 'device-9', relayToken: OK.relayToken, sid: 'sid-9', desktopPublicKey: fixture.desktopPublicKey })
    const stored = await new Vault(t.storage).loadPairing()
    expect(stored).toEqual(pairing)
    expect(JSON.parse(t.storage.data.get(VAULT_KEYS.seq)!)).toEqual({ sid: 'sid-9', seq: 0 })
    expect(t.steps.at(-1)).toBe('paired')
  })

  it('shows the Mac as not connected while the hello waits at the relay', async () => {
    const t = setup()
    void t.flow.start(qr()).catch(() => undefined)
    await untilHello(t, false)
    expect(t.full.at(-1)).toMatchObject({ step: 'waiting', queued: true })
    t.sockets.last.receive({ presence: 'online', since: new Date(NOW).toISOString(), queued: 1 })
    expect(t.full.at(-1)).toMatchObject({ step: 'waiting', queued: false })
    t.flow.cancel()
  })

  it('handles a denial and an expiry from the desktop', async () => {
    for (const reason of ['denied', 'expired'] as const) {
      const t = setup()
      const done = t.flow.start(qr())
      await untilHello(t)
      const frame = await t.fromDesktop({ pair: 'denied', reason })
      t.sockets.last.receive(frame)
      const err = await done.catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PairingError)
      expect((err as PairingError).step.step).toBe(reason)
      expect(t.sockets.last.acks()).toEqual([frame.ref])
      expect(await t.vault.loadPairing()).toBeNull()
    }
  })

  it('treats relay close 4006 as an expired code', async () => {
    const t = setup()
    const done = t.flow.start(qr())
    await untilHello(t)
    t.sockets.last.serverClose(4006)
    expect(((await done.catch((e: unknown) => e)) as PairingError).step.step).toBe('expired')
  })

  it('refuses an expired QR and a non-https relay before opening a socket', async () => {
    const t = setup()
    const expired = await t.flow.start(qr({ exp: NOW / 1000 - 1 })).catch((e: unknown) => e)
    expect((expired as PairingError).step.step).toBe('expired')
    const t2 = setup()
    const http = qr().replace('https%3A', 'http%3A')
    const bad = await t2.flow.start(http).catch((e: unknown) => e)
    expect((bad as PairingError).step).toMatchObject({ step: 'error' })
    expect((bad as PairingError).message).toMatch(/https/)
    const t3 = setup()
    expect(((await t3.flow.start('hello world').catch((e: unknown) => e)) as PairingError).step.step).toBe('error')
    expect(t.sockets.all.length + t2.sockets.all.length + t3.sockets.all.length).toBe(0)
  })

  it('ignores frames another secret sealed, and expires when the window passes', async () => {
    const t = setup()
    const done = t.flow.start(qr()).catch((e: unknown) => e)
    await untilHello(t)
    t.sockets.last.receive({ to: 'pairing-1', ref: uuid(), ...sealPairMessage({ pair: 'ok', ok: OK }, new Uint8Array(32).fill(1)), ttl: 120 })
    await settle()
    expect(t.steps.at(-1)).toBe('waiting')
    await t.clock.advance((PAIRING_TTL_SECONDS + 6) * 1000)
    expect(((await done) as PairingError).step.step).toBe('expired')
  })

  it('fails the flow when the phone cannot create its key', async () => {
    const t = setup()
    t.vault.createIdentity = () => Promise.reject(new Error('keychain locked'))
    const err = await t.flow.start(qr()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PairingError)
    expect((err as PairingError).step).toMatchObject({ step: 'error' })
    expect(t.steps.at(-1)).toBe('error')
    expect(t.sockets.all).toHaveLength(0)
  })

  it('mints a new identity for every pairing', async () => {
    const t = setup()
    void t.flow.start(qr()).catch(() => undefined)
    await untilHello(t)
    const first = toHex((await t.vault.loadIdentity())!.publicKey)
    t.flow.cancel()
    const again = new PairingFlow({ vault: t.vault, socket: t.sockets.factory, clock: t.clock, appVersion: '0.1.0', deviceName: 'x' })
    void again.start(qr()).catch(() => undefined)
    await settle()
    expect(toHex((await t.vault.loadIdentity())!.publicKey)).not.toBe(first)
    again.cancel()
  })
})
