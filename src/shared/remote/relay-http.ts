/**
 * The relay's HTTPS side (ADR-0001, "Relay deployment and room creation"): the routes the
 * desktop calls with `fetch` and the JSON bodies they exchange. The WebSocket frames are in
 * `protocol.ts`; this file only names what the desktop (E3) and the relay (E2) must agree on
 * outside the socket, so neither hard-codes the other's paths.
 *
 * Authentication is always a bearer token, never a query string or a cookie:
 * - `POST /rooms` carries the relay's `ADMIN_TOKEN` (set with `wrangler secret put`);
 * - everything under `/rooms/{roomId}` carries the room's `ownerSecret`, the same string the
 *   desktop sends in the socket's first frame (`RelayClientFrame.auth.owner`).
 *
 * Hashes are hex SHA-256 over the UTF-8 bytes of the secret *string* exactly as it is later
 * presented (the `ownerSecret` in the bearer header, the device's `relayToken` in
 * `auth.token`), so the relay compares `sha256(presented) === stored` and never stores a
 * secret in clear.
 */

import { invalid, requireId, requireRecord, rejectUnknownKeys } from './check'

/**
 * One path segment for an id. `encodeURIComponent` leaves `.` and `..` as they are, and a URL
 * parser resolves them as dot segments (`/rooms/r/devices/..` becomes `/rooms/r/`, the room
 * itself), so ids that are exactly `.` or `..` are refused here and by the body guards.
 */
function segment(id: string, what: string): string {
  return encodeURIComponent(requirePathId(id, what))
}

export const RELAY_PATHS = {
  /** `POST` (admin token): create a room. */
  rooms: '/rooms',
  /** `DELETE` (owner secret): delete the room and everything in it. */
  room: (roomId: string): string => `/rooms/${segment(roomId, 'roomId')}`,
  /** `POST` (owner secret): register a device's token hash; `DELETE …/{deviceId}`: revoke it. */
  devices: (roomId: string): string => `/rooms/${segment(roomId, 'roomId')}/devices`,
  device: (roomId: string, deviceId: string): string => `/rooms/${segment(roomId, 'roomId')}/devices/${segment(deviceId, 'deviceId')}`,
  /** `POST` (owner secret): announce a pairing id the phone may authenticate with until `exp`. */
  pairings: (roomId: string): string => `/rooms/${segment(roomId, 'roomId')}/pairings`,
  /** WebSocket upgrade; the first frame is `RelayClientFrame.auth`. */
  socket: '/ws'
} as const

export const BEARER = 'Bearer'

/** Body of `POST /rooms`. */
export interface CreateRoomRequest {
  /** Hex SHA-256 of the owner secret the desktop will present from now on. */
  ownerSecretHash: string
}

export interface CreateRoomResponse {
  roomId: string
}

/** Body of `POST /rooms/{roomId}/devices`. */
export interface RegisterDeviceRequest {
  deviceId: string
  /** Hex SHA-256 of the device's `relayToken`. */
  tokenHash: string
}

/** Body of `POST /rooms/{roomId}/pairings`. */
export interface RegisterPairingRequest {
  pairingId: string
  /** ISO; the relay closes pairing sockets after this. */
  exp: string
}

/** `requireId`, minus the dot segments `.` and `..`, for ids that become a URL path segment. */
export function requirePathId(v: unknown, what: string): string {
  const id = requireId(v, what)
  if (id === '.' || id === '..') invalid(`${what} must not be "." or "..".`)
  return id
}

const SHA256_HEX = /^[0-9a-f]{64}$/

export function requireSha256Hex(v: unknown, what: string): string {
  if (typeof v !== 'string' || !SHA256_HEX.test(v)) invalid(`${what} must be 64 hex characters.`)
  return v as string
}

export function requireCreateRoomRequest(v: unknown): CreateRoomRequest {
  const r = requireRecord(v, 'CreateRoomRequest')
  rejectUnknownKeys(r, ['ownerSecretHash'], 'CreateRoomRequest')
  return { ownerSecretHash: requireSha256Hex(r.ownerSecretHash, 'ownerSecretHash') }
}

export function requireCreateRoomResponse(v: unknown): CreateRoomResponse {
  const r = requireRecord(v, 'CreateRoomResponse')
  rejectUnknownKeys(r, ['roomId'], 'CreateRoomResponse')
  return { roomId: requirePathId(r.roomId, 'roomId') }
}

export function requireRegisterDeviceRequest(v: unknown): RegisterDeviceRequest {
  const r = requireRecord(v, 'RegisterDeviceRequest')
  rejectUnknownKeys(r, ['deviceId', 'tokenHash'], 'RegisterDeviceRequest')
  return { deviceId: requirePathId(r.deviceId, 'deviceId'), tokenHash: requireSha256Hex(r.tokenHash, 'tokenHash') }
}

export function requireRegisterPairingRequest(v: unknown): RegisterPairingRequest {
  const r = requireRecord(v, 'RegisterPairingRequest')
  rejectUnknownKeys(r, ['pairingId', 'exp'], 'RegisterPairingRequest')
  const exp = r.exp
  if (typeof exp !== 'string' || exp.length > 64 || Number.isNaN(Date.parse(exp))) invalid('exp must be an ISO date.')
  return { pairingId: requireId(r.pairingId, 'pairingId'), exp: exp as string }
}
