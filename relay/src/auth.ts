/**
 * Hashing and constant-time comparison for the three relay credentials (ADR-0001, "Relay
 * authentication and isolation"): the admin token, the owner secret and each device's relay
 * token. The relay stores and compares SHA-256 hex digests only; a plaintext credential is
 * hashed on arrival and dropped.
 */
import { BEARER, equalBytes } from '@huntgry/remote-protocol'

const encoder = new TextEncoder()

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time equality of two strings of the same length (hex digests, tokens). */
export function equalStrings(a: string, b: string): boolean {
  return equalBytes(encoder.encode(a), encoder.encode(b))
}

/** `true` when `presented` hashes to `expectedHash`; both sides go through SHA-256 so timing reveals nothing. */
export async function matchesHash(presented: string, expectedHash: string | undefined): Promise<boolean> {
  if (!expectedHash) return false
  return equalStrings(await sha256Hex(presented), expectedHash)
}

const BEARER_HEADER = new RegExp(`^${BEARER}\\s+(\\S+)$`, 'i')

/** The bearer credential of a request, or `undefined`. Never logged. */
export function bearerOf(request: Request): string | undefined {
  const header = request.headers.get('authorization') ?? ''
  return BEARER_HEADER.exec(header)?.[1]
}
