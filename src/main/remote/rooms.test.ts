import { beforeEach, describe, expect, it } from 'vitest'
import type { RelayCredentials } from './credentials'
import { REVOKE_UNCONFIRMED, RoomControl, type RoomDeps } from './rooms'

const creds = (roomId: string): RelayCredentials => ({ relayUrl: 'https://relay.example.com', adminToken: 'admin', roomId, ownerSecret: `secret-${roomId}` })

let calls: string[]
let written: RelayCredentials[]
let relayDown: boolean
let diskFull: boolean
let deps: RoomDeps

beforeEach(() => {
  calls = []
  written = []
  relayDown = false
  diskFull = false
  deps = {
    createRoom: async () => {
      calls.push('createRoom')
      if (relayDown) throw new Error('The relay answered 503 for POST /rooms.')
      return creds('room-new')
    },
    deleteRoom: async (old) => {
      calls.push(`deleteRoom(${old.roomId})`)
    },
    writeCredentials: async (c) => {
      calls.push(`write(${c.roomId})`)
      if (diskFull) throw new Error('ENOSPC: no space left on device')
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
    expect(calls).toEqual(['createRoom', 'write(room-new)', 'deleteRoom(room-old)', 'rotateKeyPair'])
    expect(rooms.revokeWarning()).toBeNull()
  })

  it('a first Save (no room to replace) keeps the key and any warning', async () => {
    const rooms = new RoomControl(deps)
    rooms.relayDidNotConfirmRevoke()
    await rooms.replaceRoom('https://relay.example.com', 'admin', null)
    expect(calls).toEqual(['createRoom', 'write(room-new)'])
    expect(rooms.revokeWarning()).toBe(REVOKE_UNCONFIRMED)
  })

  it('Unpair everything reconnects even when the relay refuses the new room, and reports the error', async () => {
    const rooms = new RoomControl(deps)
    rooms.relayDidNotConfirmRevoke()
    relayDown = true
    await expect(rooms.rotateAll(creds('room-old'))).rejects.toThrow(/503/)
    expect(calls).toEqual(['rotateKeyPair', 'stopSession', 'createRoom', 'apply'])
    expect(written).toEqual([])
    // The old room is still in use, so the warning stays.
    expect(rooms.revokeWarning()).toBe(REVOKE_UNCONFIRMED)
  })

  it('Unpair everything with a new room writes it, clears the warning and reconnects once', async () => {
    const rooms = new RoomControl(deps)
    rooms.relayDidNotConfirmRevoke()
    await rooms.rotateAll(creds('room-old'))
    expect(calls).toEqual(['rotateKeyPair', 'stopSession', 'createRoom', 'write(room-new)', 'deleteRoom(room-old)', 'apply'])
    expect(rooms.revokeWarning()).toBeNull()
  })

  it('Unpair everything without credentials only rotates the key and re-applies', async () => {
    const rooms = new RoomControl(deps)
    await rooms.rotateAll(null)
    expect(calls).toEqual(['rotateKeyPair', 'apply'])
  })

  it('keeps the old room when the new credentials cannot be saved (Rotate and Unpair everything)', async () => {
    const rooms = new RoomControl(deps)
    diskFull = true
    await expect(rooms.replaceRoom('https://relay.example.com', 'admin', creds('room-old'))).rejects.toThrow(/ENOSPC/)
    expect(calls).toEqual(['createRoom', 'write(room-new)'])
    calls = []
    await expect(rooms.rotateAll(creds('room-old'))).rejects.toThrow(/ENOSPC/)
    // relay.json still names the old room, and the old room still exists to reconnect to.
    expect(calls).toEqual(['rotateKeyPair', 'stopSession', 'createRoom', 'write(room-new)', 'apply'])
  })
})

