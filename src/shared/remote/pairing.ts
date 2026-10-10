/**
 * Pairing (ADR-0001, "Pairing"): the QR the desktop shows and the three messages exchanged
 * under `secretbox(S)` with the QR's one-time secret. Shared by the desktop's
 * `src/main/remote/pairing.ts` and the phone, so both read and write exactly one format.
 *
 * QR: `huntgry://pair?v=1&relay=<https URL>&room=<roomId>&pairing=<pairingId>&pk=<hex>&s=<hex>&exp=<unix s>`
 * - `relay` must be `https://` (the phone refuses anything else before connecting);
 * - `pairing` is the id the phone authenticates with (`{ auth: { room, pairing } }`); the ADR's
 *   sequence implies it, the URL carries it;
 * - `pk` is the desktop's X25519 public key, `s` the 32-byte pairing secret, both hex;
 * - `exp` is the second after which the desktop refuses `pair.hello` (now + 2 min).
 *
 * Frames: the phone sends `RelayFrame{ to: 'desktop', ref, ...sealPairMessage(hello, S), ttl }`
 * on its pairing socket; the desktop answers `ok` or `denied` addressed `to: pairingId`
 * (`sealPairReply` / `openPairReply`). The desktop finds the pairing by trying each open secret,
 * as it does with session keys.
 *
 * `pair.ok` carries the relay token, so it is sealed with the session key of the phone whose
 * hello is being approved (`deriveSessionKey`), not with S: anyone else who saw the QR can open
 * a socket with the same pairing id and take the phone's place on the relay, but cannot read the
 * token. `pair.denied` carries nothing and stays under S.
 */

import { ProtocolError, invalid, rejectUnknownKeys, requireBase64, requireId, requireProtocolRange, requireRecord } from './check'
import { KEY_BYTES, SECRET_BYTES, fromHex, openJson, sealJson, toHex, type Sealed } from './crypto'
import { requirePathId, requireSha256Hex } from './relay-http'
import type { PairHello, PairOk } from './protocol'
import { parseUrl } from './text'

/** How long a pairing QR is valid (the relay accepts a registration of up to 10 min). */
export const PAIRING_TTL_SECONDS = 120

export const PAIRING_URL_SCHEME = 'huntgry:'
export const PAIRING_URL_PREFIX = 'huntgry://pair?'

/** What the QR carries. */
export interface PairingInvite {
  v: 1
  /** `https://` URL of the relay, without credentials, query or fragment. */
  relay: string
  room: string
  pairing: string
  desktopPublicKey: Uint8Array
  secret: Uint8Array
  /** Unix seconds. */
  exp: number
}

/** Why the desktop declined a `pair.hello`. */
export type PairDeniedReason = 'denied' | 'expired'

/** Plaintext of a pairing frame (`secretbox` with the QR secret). */
export type PairMessage = { pair: 'hello'; hello: PairHello } | { pair: 'ok'; ok: PairOk } | { pair: 'denied'; reason: PairDeniedReason }

// ── QR ───────────────────────────────────────────────────────────────────────────────────────

/** `https://host[:port][/path]` with no credentials, query or fragment; trailing `/` removed. */
export function requireRelayUrl(v: unknown, what = 'relay'): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) invalid(`${what} must be a URL.`)
  const text = v as string
  const url = parseUrl(text)
  if (!url) invalid(`${what} must be a URL.`)
  if (url!.protocol !== 'https:') invalid(`${what} must use https://.`)
  if (url!.username || url!.password) invalid(`${what} must not carry credentials.`)
  if (text.includes('?') || text.includes('#')) invalid(`${what} must not have a query or fragment.`)
  return text.replace(/\/+$/, '')
}

/** The QR text for an invite. */
export function pairingUrl(invite: PairingInvite): string {
  const params: [string, string][] = [
    ['v', '1'],
    ['relay', requireRelayUrl(invite.relay)],
    ['room', requirePathId(invite.room, 'room')],
    ['pairing', requirePathId(invite.pairing, 'pairing')],
    ['pk', toHex(requireKey(invite.desktopPublicKey, 'pk'))],
    ['s', toHex(requireKey(invite.secret, 's'))],
    ['exp', String(requireExp(invite.exp))]
  ]
  return PAIRING_URL_PREFIX + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

/**
 * Reads a scanned QR. Throws `ProtocolError('invalid')` for anything that is not a v1 Huntgry
 * pairing URL with an `https://` relay, and `ProtocolError('expired')` once `exp` has passed.
 */
export function parsePairingUrl(text: unknown, now: number = Date.now()): PairingInvite {
  if (typeof text !== 'string' || text.length > 2048 || !text.startsWith(PAIRING_URL_PREFIX)) invalid('This is not a Huntgry pairing code.')
  const query = (text as string).slice(PAIRING_URL_PREFIX.length)
  const params = new Map<string, string>()
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) invalid('This pairing code is malformed.')
    const key = part.slice(0, eq)
    let value: string
    try {
      value = decodeURIComponent(part.slice(eq + 1))
    } catch {
      return invalid('This pairing code is malformed.')
    }
    if (params.has(key)) invalid(`This pairing code repeats "${key}".`)
    params.set(key, value)
  }
  const allowed = ['v', 'relay', 'room', 'pairing', 'pk', 's', 'exp']
  for (const key of params.keys()) if (!allowed.includes(key)) invalid(`This pairing code has an unknown field "${key}".`)
  if (params.get('v') !== '1') invalid('This pairing code is for another version of Huntgry. Update the app.')
  const exp = Number(params.get('exp'))
  const invite: PairingInvite = {
    v: 1,
    relay: requireRelayUrl(params.get('relay')),
    room: requirePathId(params.get('room'), 'room'),
    pairing: requirePathId(params.get('pairing'), 'pairing'),
    desktopPublicKey: hexKey(params.get('pk'), 'pk'),
    secret: hexKey(params.get('s'), 's'),
    exp: requireExp(exp)
  }
  if (invite.exp * 1000 <= now) throw new ProtocolError('expired', 'This pairing code has expired. Show a new one on your Mac.')
  return invite
}

function requireKey(v: unknown, what: string): Uint8Array {
  if (!(v instanceof Uint8Array) || v.length !== KEY_BYTES) invalid(`${what} must be 32 bytes.`)
  return v as Uint8Array
}

function hexKey(v: unknown, what: string): Uint8Array {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) invalid(`${what} must be 64 hex characters.`)
  return fromHex(v as string)
}

function requireExp(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) invalid('exp must be a unix time in seconds.')
  return v as number
}

// ── messages ─────────────────────────────────────────────────────────────────────────────────

export function requirePairHello(v: unknown): PairHello {
  const r = requireRecord(v, 'pair.hello')
  rejectUnknownKeys(r, ['devicePub', 'deviceName', 'appVersion', 'protocol'], 'pair.hello')
  return {
    devicePub: requireBase64(r.devicePub, 'pair.hello.devicePub', KEY_BYTES),
    deviceName: requireId(r.deviceName, 'pair.hello.deviceName'),
    appVersion: requireId(r.appVersion, 'pair.hello.appVersion', 64),
    protocol: requireProtocolRange(r.protocol, 'pair.hello.protocol')
  }
}

export function requirePairOk(v: unknown): PairOk {
  const r = requireRecord(v, 'pair.ok')
  rejectUnknownKeys(r, ['deviceId', 'relayToken', 'desktopName', 'protocol', 'sid'], 'pair.ok')
  return {
    deviceId: requirePathId(r.deviceId, 'pair.ok.deviceId'),
    // 32 random bytes, hex: the relay stores sha256 of this exact string.
    relayToken: requireSha256Hex(r.relayToken, 'pair.ok.relayToken'),
    desktopName: requireId(r.desktopName, 'pair.ok.desktopName'),
    protocol: requireProtocolRange(r.protocol, 'pair.ok.protocol'),
    sid: requireId(r.sid, 'pair.ok.sid')
  }
}

export function requirePairMessage(v: unknown): PairMessage {
  const r = requireRecord(v, 'pairing message')
  switch (r.pair) {
    case 'hello':
      rejectUnknownKeys(r, ['pair', 'hello'], 'pairing message')
      return { pair: 'hello', hello: requirePairHello(r.hello) }
    case 'ok':
      rejectUnknownKeys(r, ['pair', 'ok'], 'pairing message')
      return { pair: 'ok', ok: requirePairOk(r.ok) }
    case 'denied':
      rejectUnknownKeys(r, ['pair', 'reason'], 'pairing message')
      if (r.reason !== 'denied' && r.reason !== 'expired') invalid('pair.denied.reason must be "denied" or "expired".')
      return { pair: 'denied', reason: r.reason as PairDeniedReason }
    default:
      return invalid('Unknown pairing message.')
  }
}

/** `secretbox(S)` of a validated pairing message. */
export function sealPairMessage(message: PairMessage, secret: Uint8Array, nonce?: Uint8Array): Sealed {
  if (secret.length !== SECRET_BYTES) throw new Error('Pairing secret must be 32 bytes.')
  return sealJson(requirePairMessage(message), secret, nonce)
}

/**
 * Opens a pairing frame: `null` when the box does not open with this secret (another pairing,
 * tampering); throws `ProtocolError('invalid')` when it opens but is not a pairing message.
 */
export function openPairMessage(sealed: Sealed, secret: Uint8Array): PairMessage | null {
  const plain = openJson(sealed, secret)
  if (plain === null) return null
  return requirePairMessage(plain)
}

/** The keys of the desktop's answer: the QR secret S and the approved phone's session key. */
export interface PairReplyKeys {
  secret: Uint8Array
  /** `deriveSessionKey(devicePub, desktopSecretKey)` on the desktop, `(desktopPub, deviceSecretKey)` on the phone. */
  sessionKey?: Uint8Array
}

/** The desktop's answer: `pair.ok` under the session key, `pair.denied` under S. */
export function sealPairReply(message: PairMessage, keys: PairReplyKeys, nonce?: Uint8Array): Sealed {
  if (message.pair === 'hello') throw new Error('pair.hello is the phone\'s; seal it with sealPairMessage.')
  if (message.pair === 'denied') return sealPairMessage(message, keys.secret, nonce)
  if (!keys.sessionKey) throw new Error('pair.ok is sealed with the phone\'s session key.')
  return sealPairMessage(message, keys.sessionKey, nonce)
}

/**
 * Opens the desktop's answer on the phone: `pair.ok` only under the session key, `pair.denied`
 * only under S (anyone with the QR could forge a `pair.ok` under S). `null` when neither key
 * opens it; throws `ProtocolError('invalid')` for any other combination.
 */
export function openPairReply(sealed: Sealed, keys: Required<PairReplyKeys>): PairMessage | null {
  const ok = openPairMessage(sealed, keys.sessionKey)
  if (ok) {
    if (ok.pair !== 'ok') invalid('Only pair.ok is sealed with the session key.')
    return ok
  }
  const denied = openPairMessage(sealed, keys.secret)
  if (denied && denied.pair !== 'denied') invalid('Only pair.denied is sealed with the pairing secret.')
  return denied
}
