import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, Relay, fixture, randomId, sha256 } from './harness'

/** Room creation, owner-authenticated routes, TLS-only, credentials never in the URL. */
let relay: Relay
beforeAll(async () => {
  relay = await Relay.start()
}, 60_000)
afterAll(() => relay.dispose())

describe('POST /rooms', () => {
  it('needs the admin token before any Durable Object is touched', async () => {
    const body = { ownerSecretHash: sha256('secret') }
    expect((await relay.fetch('/rooms', { method: 'POST', body })).status).toBe(401)
    expect((await relay.fetch('/rooms', { method: 'POST', headers: { authorization: 'Bearer nope' }, body })).status).toBe(401)
    expect((await relay.fetch('/rooms', { method: 'POST', headers: { authorization: `Basic ${ADMIN_TOKEN}` }, body })).status).toBe(401)
    const ok = await relay.fetch('/rooms', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body })
    expect(ok.status).toBe(201)
    expect((ok.json as { roomId: string }).roomId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts only a SHA-256 hex digest of the owner secret, never the secret', async () => {
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}` }
    expect((await relay.fetch('/rooms', { method: 'POST', headers, body: { ownerSecret: 'plain' } })).status).toBe(400)
    expect((await relay.fetch('/rooms', { method: 'POST', headers, body: { ownerSecretHash: 'plain-secret' } })).status).toBe(400)
    expect((await relay.fetch('/rooms', { method: 'POST', headers, body: { ownerSecretHash: sha256('x').toUpperCase() } })).status).toBe(400)
    expect((await relay.fetch('/rooms', { method: 'POST', headers })).status).toBe(400)
  })

  it('rate-limits failed attempts per IP', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.7' }
    for (let i = 0; i < 5; i++) expect((await relay.fetch('/rooms', { method: 'POST', headers: { ...ip, authorization: 'Bearer wrong' }, body: {} })).status).toBe(401)
    const blocked = await relay.fetch('/rooms', { method: 'POST', headers: { ...ip, authorization: `Bearer ${ADMIN_TOKEN}` }, body: { ownerSecretHash: sha256('s') } })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another IP is unaffected.
    const other = await relay.fetch('/rooms', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.8', authorization: `Bearer ${ADMIN_TOKEN}` }, body: { ownerSecretHash: sha256('s') } })
    expect(other.status).toBe(201)
  })
})

describe('TLS only', () => {
  it('refuses plain http requests and ws upgrades', async () => {
    const res = await relay.fetch('/rooms', { origin: 'http://relay.test', method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body: { ownerSecretHash: sha256('s') } })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'https required' })
    const f = await fixture(relay)
    await expect(relay.connect(f.roomId, { origin: 'http://relay.test' })).rejects.toThrow(/400/)
  })
})

describe('owner routes', () => {
  it('require the owner secret and an existing room', async () => {
    const f = await fixture(relay)
    expect(await relay.registerDevice(f.roomId, 'wrong-secret', randomId('d'), 't')).toBe(401)
    expect(await relay.registerPairing(f.roomId, 'wrong-secret', randomId('p'))).toBe(401)
    expect(await relay.revokeDevice(f.roomId, 'wrong-secret', f.deviceId)).toBe(401)
    expect((await relay.fetch(`/rooms/${f.roomId}/devices`, { method: 'POST', body: { deviceId: 'd', tokenHash: sha256('t') } })).status).toBe(401)
    // A valid id that was never created, and a malformed one.
    const ghost = 'f'.repeat(64)
    expect(await relay.registerDevice(ghost, f.ownerSecret, 'd', 't')).toBe(404)
    expect(await relay.registerDevice('not-a-room', f.ownerSecret, 'd', 't')).toBe(404)
    await expect(relay.connect('not-a-room')).rejects.toThrow(/404/)
  })

  it('validate device and pairing registrations', async () => {
    const f = await fixture(relay)
    const headers = { authorization: `Bearer ${f.ownerSecret}` }
    expect((await relay.fetch(`/rooms/${f.roomId}/devices`, { method: 'POST', headers, body: { deviceId: 'd', tokenHash: 'plain-token' } })).status).toBe(400)
    expect((await relay.fetch(`/rooms/${f.roomId}/devices`, { method: 'POST', headers, body: { deviceId: 'desktop', tokenHash: sha256('t') } })).status).toBe(400)
    expect((await relay.fetch(`/rooms/${f.roomId}/pairings`, { method: 'POST', headers, body: { pairingId: 'p', exp: new Date(Date.now() - 1000).toISOString() } })).status).toBe(400)
    expect((await relay.fetch(`/rooms/${f.roomId}/pairings`, { method: 'POST', headers, body: { pairingId: 'p', exp: new Date(Date.now() + 3_600_000).toISOString() } })).status).toBe(400)
    expect(await relay.registerPairing(f.roomId, f.ownerSecret, 'p')).toBe(201)
    expect(await relay.revokeDevice(f.roomId, f.ownerSecret, 'never-registered')).toBe(404)
  })

  it('DELETE /rooms/:room wipes the room and closes its sockets', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    const res = await relay.fetch(`/rooms/${f.roomId}`, { method: 'DELETE', headers: { authorization: `Bearer ${f.ownerSecret}` } })
    expect(res.status).toBe(204)
    expect((await desktop.closed).code).toBe(4004)
    expect(await relay.registerDevice(f.roomId, f.ownerSecret, 'd', 't')).toBe(404)
  })
})

describe('GET /rooms/:room/ws', () => {
  it('needs an upgrade and refuses anything that could carry a credential', async () => {
    const f = await fixture(relay)
    expect((await relay.fetch(`/rooms/${f.roomId}/ws`)).status).toBe(426)
    await expect(relay.connect(f.roomId, { path: `/rooms/${f.roomId}/ws?token=${f.relayToken}` })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { path: `/rooms/${f.roomId}/ws?owner=${f.ownerSecret}` })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { headers: { authorization: `Bearer ${f.ownerSecret}` } })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { headers: { 'sec-websocket-protocol': f.relayToken } })).rejects.toThrow(/400/)
    await expect(relay.connect(f.roomId, { headers: { cookie: `token=${f.relayToken}` } })).rejects.toThrow(/400/)
  })
})
