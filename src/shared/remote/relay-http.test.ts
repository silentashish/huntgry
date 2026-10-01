import { describe, expect, it } from 'vitest'
import {
  RELAY_PATHS,
  requireCreateRoomRequest,
  requireCreateRoomResponse,
  requireRegisterDeviceRequest,
  requireRegisterPairingRequest,
  requireSha256Hex
} from './index'

const HASH = 'ab'.repeat(32)

describe('relay HTTP contract', () => {
  it('names the routes both sides use, with ids URI-encoded', () => {
    expect(RELAY_PATHS.rooms).toBe('/rooms')
    expect(RELAY_PATHS.socket).toBe('/ws')
    expect(RELAY_PATHS.room('r 1')).toBe('/rooms/r%201')
    expect(RELAY_PATHS.devices('r')).toBe('/rooms/r/devices')
    expect(RELAY_PATHS.device('r', 'd/../x')).toBe('/rooms/r/devices/d%2F..%2Fx')
    expect(RELAY_PATHS.pairings('r')).toBe('/rooms/r/pairings')
  })

  it('accepts the documented bodies and refuses unknown fields, clear secrets and bad hashes', () => {
    expect(requireCreateRoomRequest({ ownerSecretHash: HASH })).toEqual({ ownerSecretHash: HASH })
    expect(() => requireCreateRoomRequest({ ownerSecretHash: HASH, ownerSecret: 'clear' })).toThrow(/unknown field/)
    expect(() => requireCreateRoomRequest({ ownerSecretHash: 'AB'.repeat(32) })).toThrow(/hex/)
    expect(requireCreateRoomResponse({ roomId: 'room-1' })).toEqual({ roomId: 'room-1' })
    expect(() => requireCreateRoomResponse({ roomId: '' })).toThrow()
    expect(requireRegisterDeviceRequest({ deviceId: 'd', tokenHash: HASH })).toEqual({ deviceId: 'd', tokenHash: HASH })
    expect(() => requireRegisterDeviceRequest({ deviceId: 'd', token: 'clear' })).toThrow()
    expect(requireRegisterPairingRequest({ pairingId: 'p', exp: '2026-09-30T00:02:00.000Z' })).toMatchObject({ pairingId: 'p' })
    expect(() => requireRegisterPairingRequest({ pairingId: 'p', exp: 'tomorrow' })).toThrow(/ISO/)
    expect(() => requireSha256Hex('x', 'h')).toThrow()
  })
})
