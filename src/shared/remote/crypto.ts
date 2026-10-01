/**
 * The one crypto layer of the protocol, over `tweetnacl` (ADR-0001, "Security model").
 *
 * - Session key: `nacl.box.before(theirPublic, myPrivate)` (X25519 + HSalsa20), computed once
 *   per pairing on each side. `deriveSessionKey` is pinned by a fixture test so the phone and
 *   the desktop cannot drift.
 * - Every frame: `nacl.box.after(plaintext, random 24-byte nonce, sessionKey)`; the nonce
 *   travels in clear in `RelayFrame.nonce`.
 * - Pairing frames: `nacl.secretbox` with the 32-byte secret from the QR.
 *
 * No Node, DOM or React Native API is used beyond `TextEncoder` / `TextDecoder` (text.ts), so
 * the same file runs in main, in a Cloudflare Worker and under Hermes (which needs
 * `react-native-get-random-values` for `nacl.randomBytes`).
 */

import nacl from 'tweetnacl'
import type { Envelope } from './protocol'
import { utf8Decode, utf8Encode } from './text'

export const NONCE_BYTES = nacl.box.nonceLength // 24
export const KEY_BYTES = nacl.box.publicKeyLength // 32
export const SECRET_BYTES = nacl.secretbox.keyLength // 32
export const BOX_OVERHEAD_BYTES = nacl.box.overheadLength // 16 (Poly1305 tag)

export interface KeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

// ── base64 (pure JS: no Buffer in Workers or Hermes, no atob for binary) ────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = new Uint8Array(256).fill(255)
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '='
  }
  return out
}

/** Strict decoding: canonical alphabet, correct padding; throws on anything else. */
export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid base64.')
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (B64_LOOKUP[text.charCodeAt(i)] << 18) |
      (B64_LOOKUP[text.charCodeAt(i + 1)] << 12) |
      ((B64_LOOKUP[text.charCodeAt(i + 2)] & 63) << 6) |
      (B64_LOOKUP[text.charCodeAt(i + 3)] & 63)
    out[o++] = n >> 16
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) throw new Error('Invalid hex.')
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ── keys and nonces ─────────────────────────────────────────────────────────────────────────

/** A fresh X25519 keypair (desktop identity, device identity). */
export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair()
}

/** The keypair of a stored 32-byte secret key. */
export function keyPairFromSecretKey(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== nacl.box.secretKeyLength) throw new Error('Secret key must be 32 bytes.')
  return nacl.box.keyPair.fromSecretKey(secretKey)
}

/** A random 24-byte nonce; one per frame, never reused with the same key. */
export function randomNonce(): Uint8Array {
  return nacl.randomBytes(NONCE_BYTES)
}

/** Random bytes for pairing secrets, relay tokens and owner secrets. */
export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length)
}

/**
 * The shared session key: `nacl.box.before(theirPublic, mySecret)`. Both sides compute the
 * same 32 bytes (`crypto.fixture.json` pins it). Keep the key, not the peer's public key.
 */
export function deriveSessionKey(theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  if (theirPublicKey.length !== KEY_BYTES) throw new Error('Public key must be 32 bytes.')
  if (mySecretKey.length !== nacl.box.secretKeyLength) throw new Error('Secret key must be 32 bytes.')
  return nacl.box.before(theirPublicKey, mySecretKey)
}

// ── box (session frames) ────────────────────────────────────────────────────────────────────

export interface Sealed {
  /** base64, 24 bytes */
  nonce: string
  /** base64 */
  ct: string
}

/** Encrypts bytes with the session key and a fresh nonce. */
export function box(plaintext: Uint8Array, sessionKey: Uint8Array, nonce: Uint8Array = randomNonce()): Sealed {
  if (nonce.length !== NONCE_BYTES) throw new Error('Nonce must be 24 bytes.')
  return { nonce: toBase64(nonce), ct: toBase64(nacl.box.after(plaintext, nonce, sessionKey)) }
}

/** Decrypts a frame; `null` when the tag does not verify (tampered, wrong key, wrong nonce). */
export function openBox(sealed: Sealed, sessionKey: Uint8Array): Uint8Array | null {
  let nonce: Uint8Array
  let ct: Uint8Array
  try {
    nonce = fromBase64(sealed.nonce)
    ct = fromBase64(sealed.ct)
  } catch {
    return null
  }
  if (nonce.length !== NONCE_BYTES) return null
  return nacl.box.open.after(ct, nonce, sessionKey)
}

/** Serialises and encrypts an envelope: the `nonce` / `ct` pair of a `RelayFrame`. */
export function sealEnvelope(envelope: Envelope, sessionKey: Uint8Array, nonce?: Uint8Array): Sealed {
  return box(utf8Encode(JSON.stringify(envelope)), sessionKey, nonce)
}

/**
 * Decrypts and parses an envelope. `null` when the box does not open or the plaintext is not
 * JSON; run the result through `requireEnvelope` before trusting any field.
 */
export function openEnvelope(sealed: Sealed, sessionKey: Uint8Array): unknown | null {
  const plaintext = openBox(sealed, sessionKey)
  if (!plaintext) return null
  try {
    return JSON.parse(utf8Decode(plaintext))
  } catch {
    return null
  }
}

// ── secretbox (pairing frames, keyed with the QR secret) ────────────────────────────────────

export function secretbox(plaintext: Uint8Array, secret: Uint8Array, nonce: Uint8Array = randomNonce()): Sealed {
  if (secret.length !== SECRET_BYTES) throw new Error('Secret must be 32 bytes.')
  if (nonce.length !== NONCE_BYTES) throw new Error('Nonce must be 24 bytes.')
  return { nonce: toBase64(nonce), ct: toBase64(nacl.secretbox(plaintext, nonce, secret)) }
}

export function openSecretbox(sealed: Sealed, secret: Uint8Array): Uint8Array | null {
  if (secret.length !== SECRET_BYTES) return null
  let nonce: Uint8Array
  let ct: Uint8Array
  try {
    nonce = fromBase64(sealed.nonce)
    ct = fromBase64(sealed.ct)
  } catch {
    return null
  }
  if (nonce.length !== NONCE_BYTES) return null
  return nacl.secretbox.open(ct, nonce, secret)
}

export function sealJson(value: unknown, secret: Uint8Array, nonce?: Uint8Array): Sealed {
  return secretbox(utf8Encode(JSON.stringify(value)), secret, nonce)
}

export function openJson(sealed: Sealed, secret: Uint8Array): unknown | null {
  const plaintext = openSecretbox(sealed, secret)
  if (!plaintext) return null
  try {
    return JSON.parse(utf8Decode(plaintext))
  } catch {
    return null
  }
}

/** Constant-time comparison for tokens and hashes. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b)
}
