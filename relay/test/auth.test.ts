import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RelayNotice } from '@huntgry/remote-protocol'
import { Relay, fixture, frame, randomId, sleep } from './harness'

/** First-frame authentication on every socket, the auth timeout, one socket per identity. */
let relay: Relay
beforeAll(async () => {
  relay = await Relay.start({ bindings: { AUTH_TIMEOUT_MS: '400' } })
}, 60_000)
afterAll(() => relay.dispose())

describe('first-frame auth', () => {
  it('ships with a 5 s timeout', () => {
    const toml = readFileSync(resolve(__dirname, '../wrangler.toml'), 'utf8')
    expect(toml).toMatch(/AUTH_TIMEOUT_MS = "5000"/)
  })

  it('closes a socket that does not authenticate in time, and keeps one that does', async () => {
    const f = await fixture(relay)
    const silent = await relay.connect(f.roomId)
    const started = Date.now()
    const closed = await silent.closed
    expect(closed.code).toBe(4003)
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)

    const quick = await f.phone()
    await quick.next() // presence
    await sleep(600)
    expect(quick.isClosed).toBe(false)
    await quick.close()
  })

  it('accepts the owner secret, a device token and a pairing id, nothing else', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    const phone = await f.phone()
    const notice = await phone.next<RelayNotice>()
    expect(notice).toMatchObject({ presence: 'online' })

    expect((await relay.connectAs(f.roomId, { room: f.roomId, owner: 'wrong' }).then((c) => c.closed)).code).toBe(4002)
    expect((await relay.connectAs(f.roomId, { room: f.roomId, device: f.deviceId, token: 'wrong' }).then((c) => c.closed)).code).toBe(4002)
    expect((await relay.connectAs(f.roomId, { room: f.roomId, device: 'unknown', token: f.relayToken }).then((c) => c.closed)).code).toBe(4002)
    expect((await relay.connectAs(f.roomId, { room: f.roomId, pairing: 'unregistered' }).then((c) => c.closed)).code).toBe(4002)
    // Another room's id in the auth frame does not match the socket's room.
    const otherRoom = await relay.createRoom('other')
    expect((await relay.connectAs(f.roomId, { room: otherRoom, owner: f.ownerSecret }, { direct: true }).then((c) => c.closed)).code).toBe(4002)
    // Through /ws the frame picks the other room, whose owner secret this is not.
    expect((await relay.connectAs(f.roomId, { room: otherRoom, owner: f.ownerSecret }).then((c) => c.closed)).code).toBe(4002)

    // A pairing works until its expiry.
    const pairingId = randomId('pairing')
    expect(await relay.registerPairing(f.roomId, f.ownerSecret, pairingId)).toBe(201)
    const pairing = await relay.connectAs(f.roomId, { room: f.roomId, pairing: pairingId })
    expect(await pairing.next<RelayNotice>()).toMatchObject({ presence: 'online' })
    await pairing.close()

    // The first frame must be auth: a relay frame or a push token is not.
    const early = await relay.connect(f.roomId)
    early.send(frame('desktop', 'c1'))
    expect((await early.closed).code).toBe(4002)
    const token = await relay.connect(f.roomId)
    token.send({ pushToken: 'ExponentPushToken[abc]' })
    expect((await token.closed).code).toBe(4002)

    await desktop.close()
    await phone.close()
  })

  it('refuses an expired pairing', async () => {
    const f = await fixture(relay)
    const pairingId = randomId('pairing')
    expect(await relay.registerPairing(f.roomId, f.ownerSecret, pairingId, 300)).toBe(201)
    await sleep(400)
    expect((await relay.connectAs(f.roomId, { room: f.roomId, pairing: pairingId }).then((c) => c.closed)).code).toBe(4002)
  })

  it('keeps one socket per identity: a reconnect replaces the previous one', async () => {
    const f = await fixture(relay)
    const first = await f.phone()
    await first.next()
    const second = await f.phone()
    await second.next()
    expect((await first.closed).code).toBe(4000)
    expect(second.isClosed).toBe(false)

    const d1 = await f.desktop()
    const d2 = await f.desktop()
    expect((await d1.closed).code).toBe(4000)
    await sleep(100)
    expect(d2.isClosed).toBe(false)
    await second.close()
    await d2.close()
  })

  it('closes a socket that authenticates twice or sends something that is not a frame', async () => {
    const f = await fixture(relay)
    const again = await f.phone()
    await again.next()
    again.send({ auth: { room: f.roomId, device: f.deviceId, token: f.relayToken } })
    expect((await again.closed).code).toBe(1008)

    const garbage = await f.phone()
    await garbage.next()
    garbage.sendRaw('not json')
    expect((await garbage.closed).code).toBe(1008)

    const malformed = await f.phone()
    await malformed.next()
    malformed.send({ to: 'desktop', ref: 'x', nonce: 'short', ct: 'AAAA' })
    const closed = await malformed.closed
    expect(closed.code).toBe(1008)
    expect(closed.reason).not.toContain('AAAA')
  })

  it('replacing a device token closes the socket that used the old one', async () => {
    const f = await fixture(relay)
    const phone = await f.phone()
    await phone.next()
    expect(await relay.registerDevice(f.roomId, f.ownerSecret, f.deviceId, 'new-token')).toBe(201)
    expect((await phone.closed).code).toBe(4001)
    expect((await relay.connectAs(f.roomId, { room: f.roomId, device: f.deviceId, token: f.relayToken }).then((c) => c.closed)).code).toBe(4002)
    const fresh = await relay.connectAs(f.roomId, { room: f.roomId, device: f.deviceId, token: 'new-token' })
    expect(await fresh.next<RelayNotice>()).toMatchObject({ presence: 'offline' })
    await fresh.close()
  })
})
