import { beforeEach, describe, expect, it } from 'vitest'
import type { RelayCredentials } from './credentials'
import { REVOKE_UNCONFIRMED, RoomControl, type RoomDeps } from './rooms'

const creds = (roomId: string): RelayCredentials => ({ relayUrl: 'https://relay.example.com', adminToken: 'admin', roomId, ownerSecret: `secret-${roomId}` })

let calls: string[]
let written: RelayCredentials[]
let relayDown: boolean
let deps: RoomDeps

beforeEach(() => {
  calls = []
  written = []
  relayDown = false
  deps = {
    createRoom: async (_url, _token, previous) => {
      calls.push(`createRoom(${previous?.roomId ?? 'none'})`)
      if (relayDown) throw new Error('The relay answered 503 for POST /rooms.')
      return creds('room-new')
    },
    writeCredentials: async (c) => {
      calls.push(`write(${c.roomId})`)
      written.push(c)
    },
    rotateKeyPair: async () => calls.push('rotateKeyPair'),
    stopSession: () => calls.push('stopSession'),
    apply: async () => calls.push('apply')
  }
})

describe('RoomControl', () => {
  it('Rotate in the relay form clears the unconfirmed-revocation warning', async () => {
    const rooms = new RoomControl(deps)
    rooms.relayDidNotConfirmRevoke()
    expect(rooms.revokeWarning()).toBe(REVOKE_UNCONFIRMED)
    await rooms.replaceRoom('https://relay.example.com', 'admin', creds('room-old'))
    expect(calls).toEqual(['createRoom(room-old)', 'write(room-new)', 'rotateKeyPair'])
    expect(rooms.revokeWarning()).toBeNull()
  })

  it('a first Save (no room to replace) keeps the key and any warning', async () => {
    const rooms = new RoomControl(deps)
    rooms.relayDidNotConfirmRevoke()
    await rooms.replaceRoom('https://relay.example.com', 'admin', null)
    expect(calls).toEqual(['createRoom(none)', 'write(room-new)'])
    expect(rooms.revokeWarning()).toBe(REVOKE_UNCONFIRMED)
  })

  it('Unpair everything reconnects even when the relay refuses the new room, and reports the error', async () => {
    const rooms = new RoomControl(deps)
    rooms.relayDidNotConfirmRevoke()
    relayDown = true
    await expect(rooms.rotateAll(creds('room-old'))).rejects.toThrow(/503/)
    expect(calls).toEqual(['rotateKeyPair', 'stopSession', 'createRoom(room-old)', 'apply'])
    expect(written).toEqual([])
    // The old room is still in use, so the warning stays.
    expect(rooms.revokeWarning()).toBe(REVOKE_UNCONFIRMED)
  })

  it('Unpair everything with a new room writes it, clears the warning and reconnects once', async () => {
    const rooms = new RoomControl(deps)
    rooms.relayDidNotConfirmRevoke()
    await rooms.rotateAll(creds('room-old'))
    expect(calls).toEqual(['rotateKeyPair', 'stopSession', 'createRoom(room-old)', 'write(room-new)', 'apply'])
    expect(rooms.revokeWarning()).toBeNull()
  })

  it('Unpair everything without credentials only rotates the key and re-applies', async () => {
    const rooms = new RoomControl(deps)
    await rooms.rotateAll(null)
    expect(calls).toEqual(['rotateKeyPair', 'apply'])
  })
})
