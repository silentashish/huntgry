import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RELAY_PATHS, type RelayNotice } from '@huntgry/remote-protocol'
import { ADMIN_TOKEN, Relay, directSocketPath, fixture, frame, randomId, sha256 } from './harness'

/** Room creation, owner-authenticated routes, TLS-only, credentials never in the URL. */
let relay: Relay
beforeAll(async () => {
  relay = await Relay.start()
}, 60_000)
afterAll(() => relay.dispose())

describe('POST /rooms', () => {
  it('needs the admin token before any Durable Object is touched', async () => {
    const body = { ownerSecretHash: sha256('secret') }
    expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', body })).status).toBe(401)
    expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers: { authorization: 'Bearer nope' }, body })).status).toBe(401)
    expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers: { authorization: `Basic ${ADMIN_TOKEN}` }, body })).status).toBe(401)
    const ok = await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers: Relay.bearer(ADMIN_TOKEN), body })
    expect(ok.status).toBe(201)
    expect((ok.json as { roomId: string }).roomId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts only a SHA-256 hex digest of the owner secret, never the secret', async () => {
    const headers = Relay.bearer(ADMIN_TOKEN)
    expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers, body: { ownerSecret: 'plain' } })).status).toBe(400)
    expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers, body: { ownerSecretHash: 'plain-secret' } })).status).toBe(400)
    expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers, body: { ownerSecretHash: sha256('x').toUpperCase() } })).status).toBe(400)
    expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers })).status).toBe(400)
  })

  it('rate-limits failed attempts per IP', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.7' }
    for (let i = 0; i < 5; i++) expect((await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers: { ...ip, authorization: 'Bearer wrong' }, body: {} })).status).toBe(401)
    const blocked = await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers: { ...ip, ...Relay.bearer(ADMIN_TOKEN) }, body: { ownerSecretHash: sha256('s') } })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another IP is unaffected.
    const other = await relay.fetch(RELAY_PATHS.rooms, { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.8', ...Relay.bearer(ADMIN_TOKEN) }, body: { ownerSecretHash: sha256('s') } })
    expect(other.status).toBe(201)
  })
})

describe('TLS only', () => {
  it('refuses plain http requests and ws upgrades', async () => {
    const res = await relay.fetch(RELAY_PATHS.rooms, { origin: 'http://relay.test', method: 'POST', headers: Relay.bearer(ADMIN_TOKEN), body: { ownerSecretHash: sha256('s') } })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'https required' })
    const f = await fixture(relay)
    await expect(relay.connect(f.roomId, { origin: 'http://relay.test' })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { origin: 'http://relay.test', direct: true })).rejects.toThrow(/400/)
  })
})

describe('owner routes', () => {
  it('require the owner secret and an existing room', async () => {
    const f = await fixture(relay)
    expect(await relay.registerDevice(f.roomId, 'wrong-secret', randomId('d'), 't')).toBe(401)
    expect(await relay.registerPairing(f.roomId, 'wrong-secret', randomId('p'))).toBe(401)
    expect(await relay.revokeDevice(f.roomId, 'wrong-secret', f.deviceId)).toBe(401)
    expect((await relay.fetch(RELAY_PATHS.devices(f.roomId), { method: 'POST', body: { deviceId: 'd', tokenHash: sha256('t') } })).status).toBe(401)
    // A valid id that was never created, and a malformed one.
    const ghost = 'f'.repeat(64)
    expect(await relay.registerDevice(ghost, f.ownerSecret, 'd', 't')).toBe(404)
    expect(await relay.registerDevice('not-a-room', f.ownerSecret, 'd', 't')).toBe(404)
    await expect(relay.connect('not-a-room', { direct: true })).rejects.toThrow(/404/)
  })

  it('validate device and pairing registrations', async () => {
    const f = await fixture(relay)
    const headers = Relay.bearer(f.ownerSecret)
    expect((await relay.fetch(RELAY_PATHS.devices(f.roomId), { method: 'POST', headers, body: { deviceId: 'd', tokenHash: 'plain-token' } })).status).toBe(400)
    expect((await relay.fetch(RELAY_PATHS.devices(f.roomId), { method: 'POST', headers, body: { deviceId: 'desktop', tokenHash: sha256('t') } })).status).toBe(400)
    expect((await relay.fetch(RELAY_PATHS.pairings(f.roomId), { method: 'POST', headers, body: { pairingId: 'p', exp: new Date(Date.now() - 1000).toISOString() } })).status).toBe(400)
    expect((await relay.fetch(RELAY_PATHS.pairings(f.roomId), { method: 'POST', headers, body: { pairingId: 'p', exp: new Date(Date.now() + 3_600_000).toISOString() } })).status).toBe(400)
    expect(await relay.registerPairing(f.roomId, f.ownerSecret, 'p')).toBe(201)
    expect(await relay.revokeDevice(f.roomId, f.ownerSecret, 'never-registered')).toBe(404)
  })

  it('DELETE /rooms/:room wipes the room and closes its sockets', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    expect(await relay.deleteRoom(f.roomId, f.ownerSecret)).toBe(204)
    expect((await desktop.closed).code).toBe(4004)
    expect(await relay.registerDevice(f.roomId, f.ownerSecret, 'd', 't')).toBe(404)
  })
})

describe('device ids in paths', () => {
  it('round-trip through RELAY_PATHS.device encoding, so any registered id can be revoked', async () => {
    const f = await fixture(relay)
    const odd = 'phone/1 ä?#%'
    expect(await relay.registerDevice(f.roomId, f.ownerSecret, odd, 'tok')).toBe(201)
    const phone = await relay.connectAs(f.roomId, { room: f.roomId, device: odd, token: 'tok' })
    await phone.next()
    expect(await relay.revokeDevice(f.roomId, f.ownerSecret, odd)).toBe(204)
    expect((await phone.closed).code).toBe(4001)
    expect(await relay.revokeDevice(f.roomId, f.ownerSecret, odd)).toBe(404)
    expect((await relay.fetch(`${RELAY_PATHS.devices(f.roomId)}/%E0%A4%A`, { method: 'DELETE', headers: Relay.bearer(f.ownerSecret) })).status).toBe(404)
  })
})

describe.each([
  ['GET /ws', (_roomId: string) => RELAY_PATHS.socket],
  ['GET /rooms/:room/ws', directSocketPath]
])('%s', (_name, pathOf) => {
  it('needs an upgrade and refuses anything that could carry a credential', async () => {
    const f = await fixture(relay)
    const path = pathOf(f.roomId)
    expect((await relay.fetch(path)).status).toBe(426)
    await expect(relay.connect(f.roomId, { path: `${path}?token=${f.relayToken}` })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { path: `${path}?owner=${f.ownerSecret}` })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { path, headers: Relay.bearer(f.ownerSecret) })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { path, headers: { 'sec-websocket-protocol': f.relayToken } })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { path, headers: { cookie: `token=${f.relayToken}` } })).rejects.toThrow(/400/)
  })
})

describe('GET /ws routes by the room in the auth frame', () => {
  it('refuses a first frame that is not auth, or names a malformed or unknown room', async () => {
    const f = await fixture(relay)
    const cases: unknown[] = [
      frame('desktop', 'c1'),
      { pushToken: null },
      { auth: { room: 'not-a-room', owner: f.ownerSecret } },
      { auth: { room: 'f'.repeat(64), owner: f.ownerSecret } }
    ]
    for (const first of cases) {
      const client = await relay.connect(f.roomId)
      client.send(first as Record<string, unknown>)
      expect((await client.closed).code).toBe(4002)
    }
    const huge = await relay.connect(f.roomId)
    huge.send({ auth: { room: f.roomId, owner: 'x'.repeat(4000) } })
    expect((await huge.closed).code).toBe(4002)
  })

  it('forwards frames sent right behind the auth frame, both ways, and the room close codes', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    // The phone does not wait for anything between auth and its first frame.
    const phone = await relay.connect(f.roomId)
    phone.send({ auth: { room: f.roomId, device: f.deviceId, token: f.relayToken } })
    const sent = frame('desktop', 'c-early')
    phone.send(sent)
    expect(await phone.next<RelayNotice>()).toMatchObject({ presence: 'online' })
    expect(await desktop.next()).toEqual(sent)
    const back = frame(f.deviceId, 'r-early', { ack: 'c-early' })
    desktop.send(back)
    const { ack: _ack, ...forwarded } = back
    expect(await phone.next()).toEqual(forwarded)

    // A phone on the room-scoped route and one on /ws reach the same room.
    const direct = await relay.connectAs(f.roomId, { room: f.roomId, device: f.deviceId, token: f.relayToken }, { direct: true })
    expect((await phone.closed).code).toBe(4000)
    await direct.next()
    expect(await relay.revokeDevice(f.roomId, f.ownerSecret, f.deviceId)).toBe(204)
    expect((await direct.closed).code).toBe(4001)
    await desktop.close()
  })
})
