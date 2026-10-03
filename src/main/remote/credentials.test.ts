import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, newOwnerSecret, normalizeRelayUrl, relayRequest, socketUrl } from './credentials'
import { brokenCipher, fakeCipher } from './test-helpers'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-creds-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const creds = { relayUrl: 'https://relay.example.com', adminToken: 'admin-secret', roomId: 'room-1', ownerSecret: newOwnerSecret() }

describe('relay URL', () => {
  it('accepts https only and derives wss', () => {
    expect(normalizeRelayUrl('https://relay.example.com/')).toBe('https://relay.example.com')
    expect(normalizeRelayUrl(' https://relay.example.com:8443/base/ ')).toBe('https://relay.example.com:8443/base')
    expect(socketUrl('https://relay.example.com', '/ws')).toBe('wss://relay.example.com/ws')
    for (const bad of ['http://relay.example.com', 'ws://relay.example.com', 'wss://relay.example.com', 'relay.example.com', 'https://user:pw@relay.example.com', 'https://relay.example.com/?x=1', 'file:///etc/passwd', '', 42]) {
      expect(() => normalizeRelayUrl(bad), String(bad)).toThrow()
    }
  })

  it('builds every request with a bearer header and redirect: error', () => {
    const { url, init } = relayRequest(creds.relayUrl, '/rooms', 'tok', 'POST', { ownerSecretHash: 'x' })
    expect(url).toBe('https://relay.example.com/rooms')
    expect(init.redirect).toBe('error')
    expect(init.headers.authorization).toBe('Bearer tok')
    expect(init.body).toBe('{"ownerSecretHash":"x"}')
    expect(() => relayRequest('http://relay.example.com', '/rooms', 'tok', 'POST')).toThrow(/https/)
  })
})

describe('CredentialStore', () => {
  it('stores one encrypted blob and reads it back after a "restart"', async () => {
    const store = new CredentialStore(dir, fakeCipher())
    expect(await store.read()).toEqual({ status: 'none' })
    await store.write(creds)
    const raw = await readFile(join(dir, 'relay.json'), 'utf8')
    expect(raw).not.toContain(creds.adminToken)
    expect(raw).not.toContain(creds.ownerSecret)
    expect(raw).not.toContain('relay.example.com')
    expect(JSON.parse(raw)).toMatchObject({ version: 1 })
    const again = new CredentialStore(dir, fakeCipher())
    expect(await again.read()).toEqual({ status: 'ok', credentials: creds })
  })

  it('reports an undecryptable blob as unreadable, never guesses', async () => {
    await new CredentialStore(dir, fakeCipher()).write(creds)
    const read = await new CredentialStore(dir, brokenCipher()).read()
    expect(read.status).toBe('unreadable')
    expect((read as { error: string }).error).toMatch(/unreadable/i)
    await writeFile(join(dir, 'relay.json'), 'not json')
    expect((await new CredentialStore(dir, fakeCipher()).read()).status).toBe('unreadable')
  })

  it('refuses to save when encryption is unavailable', async () => {
    await expect(new CredentialStore(dir, fakeCipher(false)).write(creds)).rejects.toThrow(/Encrypted storage/)
  })
})
