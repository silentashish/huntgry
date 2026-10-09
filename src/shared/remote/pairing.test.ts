import { describe, expect, it } from 'vitest'
import fixture from './crypto.fixture.json'
import { ProtocolError } from './check'
import { fromHex, generateKeyPair, randomBytes, sealJson, toBase64 } from './crypto'
import {
  PAIRING_TTL_SECONDS,
  openPairMessage,
  pairingUrl,
  parsePairingUrl,
  requirePairMessage,
  requireRelayUrl,
  sealPairMessage,
  type PairMessage,
  type PairingInvite
} from './pairing'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const exp = NOW / 1000 + PAIRING_TTL_SECONDS

const invite = (over: Partial<PairingInvite> = {}): PairingInvite => ({
  v: 1,
  relay: 'https://relay.huntgry.tech',
  room: 'room-1',
  pairing: 'pairing-1',
  desktopPublicKey: fromHex(fixture.desktopPublicKey),
  secret: fromHex(fixture.pairingSecret),
  exp,
  ...over
})

const code = (e: unknown) => (e instanceof ProtocolError ? e.code : String(e))
const errorOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return null
}

describe('pairing QR', () => {
  it('round-trips every field', () => {
    const url = pairingUrl(invite())
    expect(url).toMatch(/^huntgry:\/\/pair\?v=1&relay=https%3A%2F%2Frelay\.huntgry\.tech&room=room-1&pairing=pairing-1&pk=[0-9a-f]{64}&s=[0-9a-f]{64}&exp=\d+$/)
    const back = parsePairingUrl(url, NOW)
    expect(back.relay).toBe('https://relay.huntgry.tech')
    expect(back.room).toBe('room-1')
    expect(back.pairing).toBe('pairing-1')
    expect(back.exp).toBe(exp)
    expect(Array.from(back.desktopPublicKey)).toEqual(Array.from(fromHex(fixture.desktopPublicKey)))
    expect(Array.from(back.secret)).toEqual(Array.from(fromHex(fixture.pairingSecret)))
  })

  it('fits a QR comfortably', () => {
    expect(pairingUrl(invite()).length).toBeLessThan(400)
  })

  it('keeps a relay path and drops a trailing slash', () => {
    expect(parsePairingUrl(pairingUrl(invite({ relay: 'https://example.com/relay/' })), NOW).relay).toBe('https://example.com/relay')
  })

  it('refuses a relay that is not https', () => {
    for (const relay of ['http://relay.example.com', 'wss://relay.example.com', 'ftp://x', 'relay.example.com', 'https://user:pw@relay.example.com', 'https://relay.example.com/?x=1', 'https://relay.example.com/#a']) {
      expect(code(errorOf(() => requireRelayUrl(relay))), relay).toBe('invalid')
    }
    const url = pairingUrl(invite()).replace('https%3A', 'http%3A')
    expect(code(errorOf(() => parsePairingUrl(url, NOW)))).toBe('invalid')
  })

  it('reports an expired code as expired', () => {
    expect(code(errorOf(() => parsePairingUrl(pairingUrl(invite()), (exp + 1) * 1000)))).toBe('expired')
  })

  it('refuses malformed codes', () => {
    const good = pairingUrl(invite())
    const bad = [
      'https://huntgry.tech',
      'huntgry://other?v=1',
      good.replace('v=1', 'v=2'),
      good.replace(/pk=[0-9a-f]{64}/, 'pk=abcd'),
      good.replace(/s=[0-9a-f]{64}/, 's=' + 'G'.repeat(64)),
      good.replace(/exp=\d+/, 'exp=soon'),
      good.replace(/&pairing=[^&]+/, ''),
      good + '&extra=1',
      good + '&room=again',
      good.replace('room=room-1', 'room=..'),
      good.replace('room=room-1', 'room=%E0%A4%A')
    ]
    for (const text of bad) expect(code(errorOf(() => parsePairingUrl(text, NOW))), text).toBe('invalid')
    expect(code(errorOf(() => parsePairingUrl(42, NOW)))).toBe('invalid')
  })
})

describe('pairing messages', () => {
  const secret = fromHex(fixture.pairingSecret)

  it('matches the pinned fixture (desktop and phone cannot drift)', () => {
    const sealed = sealPairMessage(fixture.pairHello as PairMessage, secret, fromHex(fixture.nonce))
    expect(sealed.ct).toBe(fixture.pairHelloCt)
    expect(openPairMessage({ nonce: toBase64(fromHex(fixture.nonce)), ct: fixture.pairHelloCt }, secret)).toEqual(fixture.pairHello)
  })

  it('round-trips hello, ok and denied with a random nonce', () => {
    const messages: PairMessage[] = [
      { pair: 'hello', hello: { devicePub: toBase64(generateKeyPair().publicKey), deviceName: 'Pixel', appVersion: '1.0.0', protocol: { min: 1, max: 1 } } },
      { pair: 'ok', ok: { deviceId: 'dev-1', relayToken: 'a'.repeat(64), desktopName: 'MacBook', protocol: { min: 1, max: 1 }, sid: 'sid-1' } },
      { pair: 'denied', reason: 'denied' },
      { pair: 'denied', reason: 'expired' }
    ]
    for (const m of messages) expect(openPairMessage(sealPairMessage(m, secret), secret)).toEqual(m)
  })

  it('returns null for another secret or a tampered box', () => {
    const sealed = sealPairMessage({ pair: 'denied', reason: 'denied' }, secret)
    expect(openPairMessage(sealed, randomBytes(32))).toBeNull()
    const ct = fromHex('00') // wrong length
    expect(openPairMessage({ nonce: sealed.nonce, ct: toBase64(ct) }, secret)).toBeNull()
  })

  it('refuses malformed messages', () => {
    const bad: unknown[] = [
      null,
      { pair: 'nope' },
      { pair: 'hello', hello: { devicePub: 'short', deviceName: 'x', appVersion: '1', protocol: { min: 1, max: 1 } } },
      { pair: 'hello', hello: { devicePub: toBase64(generateKeyPair().publicKey), deviceName: '', appVersion: '1', protocol: { min: 1, max: 1 } } },
      { pair: 'hello', hello: { devicePub: toBase64(generateKeyPair().publicKey), deviceName: 'x', appVersion: '1', protocol: { min: 1, max: 1 }, extra: 1 } },
      { pair: 'ok', ok: { deviceId: 'd', relayToken: 'not-hex', desktopName: 'm', protocol: { min: 1, max: 1 }, sid: 's' } },
      { pair: 'ok', ok: { deviceId: '..', relayToken: 'a'.repeat(64), desktopName: 'm', protocol: { min: 1, max: 1 }, sid: 's' } },
      { pair: 'denied', reason: 'because' },
      { pair: 'denied', reason: 'denied', extra: true }
    ]
    for (const v of bad) expect(code(errorOf(() => requirePairMessage(v))), JSON.stringify(v)).toBe('invalid')
  })

  it('throws invalid (not null) when the box opens but holds junk', () => {
    expect(code(errorOf(() => openPairMessage(sealJson({ hello: 1 }, secret), secret)))).toBe('invalid')
  })
})
