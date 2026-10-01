import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOX_OVERHEAD_BYTES,
  box,
  deriveSessionKey,
  equalBytes,
  fromBase64,
  fromHex,
  generateKeyPair,
  keyPairFromSecretKey,
  NONCE_BYTES,
  openBox,
  openEnvelope,
  openJson,
  openSecretbox,
  randomNonce,
  sealEnvelope,
  sealJson,
  secretbox,
  toBase64,
  toHex
} from './crypto'
import type { Envelope } from './protocol'

const fixture = JSON.parse(readFileSync(join(__dirname, 'crypto.fixture.json'), 'utf8')) as Record<string, string> & { envelope: Envelope }

const envelope: Envelope = { v: 1, sid: 'sid-1', from: 'phone', seq: 7, ts: '2026-09-30T10:00:00.000Z', ttl: 60, kind: 'ping', body: null }

describe('base64 / hex', () => {
  it('round-trips every length and rejects sloppy input', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)
      const text = toBase64(bytes)
      expect(text).toBe(Buffer.from(bytes).toString('base64'))
      expect(fromBase64(text)).toEqual(bytes)
      expect(fromHex(toHex(bytes))).toEqual(bytes)
    }
    expect(() => fromBase64('abc')).toThrow()
    expect(() => fromBase64('ab$=')).toThrow()
    expect(() => fromBase64('a===')).toThrow()
    expect(() => fromHex('abc')).toThrow()
    expect(() => fromHex('zz')).toThrow()
  })
})

describe('box between two keypairs', () => {
  it('round-trips with random 24-byte nonces and both sides derive the same key', () => {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const desktopKey = deriveSessionKey(phone.publicKey, desktop.secretKey)
    const phoneKey = deriveSessionKey(desktop.publicKey, phone.secretKey)
    expect(toHex(desktopKey)).toBe(toHex(phoneKey))
    expect(desktopKey.length).toBe(32)

    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const sealed = sealEnvelope({ ...envelope, seq: i }, phoneKey)
      expect(fromBase64(sealed.nonce).length).toBe(NONCE_BYTES)
      expect(seen.has(sealed.nonce)).toBe(false)
      seen.add(sealed.nonce)
      expect(openEnvelope(sealed, desktopKey)).toEqual({ ...envelope, seq: i })
    }
    const nonce = randomNonce()
    expect(nonce.length).toBe(24)
    const raw = box(new Uint8Array([1, 2, 3]), desktopKey, nonce)
    expect(fromBase64(raw.ct).length).toBe(3 + BOX_OVERHEAD_BYTES)
    expect(openBox(raw, phoneKey)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects a tampered ciphertext, a wrong key and a wrong nonce', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const c = generateKeyPair()
    const key = deriveSessionKey(b.publicKey, a.secretKey)
    const sealed = sealEnvelope(envelope, key)
    const ct = fromBase64(sealed.ct)
    ct[ct.length - 1] ^= 1
    expect(openEnvelope({ ...sealed, ct: toBase64(ct) }, key)).toBeNull()
    expect(openEnvelope({ ...sealed, ct: sealed.ct.slice(4) }, key)).toBeNull()
    expect(openEnvelope({ ...sealed, nonce: toBase64(randomNonce()) }, key)).toBeNull()
    expect(openEnvelope({ ...sealed, nonce: 'short' }, key)).toBeNull()
    expect(openEnvelope(sealed, deriveSessionKey(c.publicKey, a.secretKey))).toBeNull()
    // Valid box around non-JSON plaintext is not an envelope either.
    expect(openEnvelope(box(new Uint8Array([0x7b]), key), key)).toBeNull()
    expect(() => box(new Uint8Array(1), key, new Uint8Array(23))).toThrow()
  })
})

describe('secretbox (pairing)', () => {
  it('round-trips with the QR secret and rejects tampering', () => {
    const secret = fromHex(fixture.pairingSecret)
    const sealed = sealJson({ devicePub: 'x', deviceName: 'Phone' }, secret)
    expect(openJson(sealed, secret)).toEqual({ devicePub: 'x', deviceName: 'Phone' })
    const ct = fromBase64(sealed.ct)
    ct[0] ^= 0x80
    expect(openJson({ ...sealed, ct: toBase64(ct) }, secret)).toBeNull()
    expect(openJson(sealed, fromHex(fixture.sessionKey))).toBeNull()
    expect(openSecretbox(sealed, new Uint8Array(31))).toBeNull()
    expect(() => secretbox(new Uint8Array(1), new Uint8Array(31))).toThrow()
  })
})

describe('fixture (phone and desktop must agree)', () => {
  const desktop = keyPairFromSecretKey(fromHex(fixture.desktopSecretKey))
  const phone = keyPairFromSecretKey(fromHex(fixture.phoneSecretKey))

  it('derives the pinned public keys and session key on both sides', () => {
    expect(toHex(desktop.publicKey)).toBe(fixture.desktopPublicKey)
    expect(toHex(phone.publicKey)).toBe(fixture.phonePublicKey)
    expect(toHex(deriveSessionKey(phone.publicKey, desktop.secretKey))).toBe(fixture.sessionKey)
    expect(toHex(deriveSessionKey(desktop.publicKey, phone.secretKey))).toBe(fixture.sessionKey)
  })

  it('seals the pinned envelope to the pinned ciphertext with the pinned nonce', () => {
    const key = fromHex(fixture.sessionKey)
    const sealed = sealEnvelope(fixture.envelope as Envelope, key, fromHex(fixture.nonce))
    expect(sealed).toEqual({ nonce: toBase64(fromHex(fixture.nonce)), ct: fixture.ct })
    expect(openEnvelope({ nonce: sealed.nonce, ct: fixture.ct }, key)).toEqual(fixture.envelope)
  })

  it('pins the pairing secretbox', () => {
    const sealed = sealJson(JSON.parse(fixture.pairingPlaintext), fromHex(fixture.pairingSecret), fromHex(fixture.nonce))
    expect(sealed.ct).toBe(fixture.pairingCt)
  })

  it('compares bytes in constant time helper', () => {
    expect(equalBytes(fromHex('00ff'), fromHex('00ff'))).toBe(true)
    expect(equalBytes(fromHex('00ff'), fromHex('00fe'))).toBe(false)
    expect(equalBytes(fromHex('00ff'), fromHex('00'))).toBe(false)
    expect(() => keyPairFromSecretKey(new Uint8Array(16))).toThrow()
    expect(() => deriveSessionKey(new Uint8Array(16), desktop.secretKey)).toThrow()
  })
})
