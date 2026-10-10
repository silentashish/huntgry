import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PAIRING_TTL_SECONDS,
  deriveSessionKey,
  generateKeyPair,
  openPairMessage,
  openPairReply,
  parsePairingUrl,
  sealPairMessage,
  toBase64,
  toHex,
  type KeyPair,
  type PairMessage,
  type PairingInvite,
  type RelayFrame
} from '@shared/remote'
import { DeviceStore } from './devices'
import { APPROVAL_SECONDS, PairingManager, renderQrSvg, sha256Hex, type PairingDeps } from './pairing'
import { fakeCipher } from './test-helpers'

/** Pairing on the desktop (#37): one-time secret, expiry, approve / deny, registration, wrong secrets. */

const T0 = Date.parse('2026-10-09T12:00:00.000Z')

let dir: string
let devices: DeviceStore
let now: number
let online: boolean
let calls: string[]
let sent: RelayFrame[]
let acks: string[]
let qrText: string
let relayDown: boolean
let roomId: string
/** Runs while `registerDevice` is pending (the relay call is in flight). */
let duringRegister: (() => void) | null
let manager: PairingManager

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-pairing-'))
  devices = new DeviceStore(dir, fakeCipher())
  await devices.load()
  now = T0
  online = true
  calls = []
  sent = []
  acks = []
  qrText = ''
  relayDown = false
  roomId = 'room-1'
  duringRegister = null
  const deps: PairingDeps = {
    devices: {
      keyPair: () => devices.keyPair(),
      list: () => devices.list(),
      add: async (record) => {
        calls.push(`add(${record.id})`)
        await devices.add(record)
      },
      remove: async (id) => {
        calls.push(`remove(${id})`)
        return devices.remove(id)
      }
    },
    relay: () => ({ relayUrl: 'https://relay.example.com', roomId }),
    registerPairing: async (pairingId, exp) => {
      calls.push(`registerPairing(${pairingId},${exp})`)
    },
    registerDevice: async (deviceId, tokenHash) => {
      calls.push(`registerDevice(${deviceId},${tokenHash})`)
      if (relayDown) throw new Error('The relay answered 503 for POST /rooms/room-1/devices.')
      duringRegister?.()
    },
    unregisterDevice: async (deviceId) => {
      calls.push(`unregisterDevice(${deviceId})`)
    },
    send: async (frame) => {
      if (!online) return false
      calls.push(`send(${frame.to})`)
      sent.push(frame)
      return true
    },
    ack: async (ref) => {
      acks.push(ref)
    },
    online: () => online,
    desktopName: 'Ashish’s Mac',
    renderQr: (text) => {
      qrText = text
      return 'data:image/svg+xml;base64,AAAA'
    },
    now: () => now
  }
  manager = new PairingManager(deps)
})

afterEach(async () => {
  manager.cancelAll()
  await devices.flush()
  await rm(dir, { recursive: true, force: true })
})

/** What a phone does after scanning: its keypair and a sealed `pair.hello` frame. */
function phoneHello(invite: PairingInvite, name = 'Test iPhone', keys: KeyPair = generateKeyPair()): { keys: KeyPair; frame: RelayFrame } {
  const message: PairMessage = { pair: 'hello', hello: { devicePub: toBase64(keys.publicKey), deviceName: name, appVersion: '1.0.0', protocol: { min: 1, max: 1 } } }
  return { keys, frame: { to: 'desktop', ref: randomUUID(), ...sealPairMessage(message, invite.secret), ttl: 120 } }
}

/** Opens the desktop's answer the way the phone does (`keys`: the phone that sent the hello). */
function answer(invite: PairingInvite, frame: RelayFrame, keys: KeyPair = generateKeyPair()): PairMessage {
  expect(frame.to).toBe(invite.pairing)
  const message = openPairReply(frame, { secret: invite.secret, sessionKey: deriveSessionKey(invite.desktopPublicKey, keys.secretKey) })
  expect(message, 'the phone opens the answer').not.toBeNull()
  return message!
}

async function scanned(): Promise<{ pairingId: string; invite: PairingInvite }> {
  const start = await manager.start()
  return { pairingId: start.pairingId, invite: parsePairingUrl(qrText, now) }
}

describe('PairingManager', () => {
  it('shows a fresh QR: https relay, room, pairing id, desktop key, 32-byte secret, exp = now + 2 min; registers the pairing', async () => {
    const start = await manager.start()
    const invite = parsePairingUrl(qrText, now)
    expect(invite.relay).toBe('https://relay.example.com')
    expect(invite.room).toBe('room-1')
    expect(invite.pairing).toBe(start.pairingId)
    expect(toHex(invite.desktopPublicKey)).toBe(toHex((await devices.keyPair())!.publicKey))
    expect(invite.secret).toHaveLength(32)
    expect(invite.exp).toBe(T0 / 1000 + PAIRING_TTL_SECONDS)
    expect(start.expiresAt).toBe(new Date(invite.exp * 1000).toISOString())
    // The relay keeps the pairing socket open while the owner decides.
    expect(calls).toEqual([`registerPairing(${start.pairingId},${new Date((invite.exp + APPROVAL_SECONDS) * 1000).toISOString()})`])
    expect(manager.list()).toEqual([{ id: start.pairingId, status: 'waiting', expiresAt: start.expiresAt, decideBy: new Date((invite.exp + APPROVAL_SECONDS) * 1000).toISOString() }])

    // A second code gets a new secret and withdraws the first one nobody scanned.
    const first = invite
    const second = await manager.start()
    expect(parsePairingUrl(qrText, now).secret).not.toEqual(first.secret)
    expect(manager.list().map((p) => p.id)).toEqual([second.pairingId])
    expect(await manager.receive(phoneHello(first).frame)).toBe(false)
  })

  it('renders the QR in main: an SVG image, the secret never in clear', async () => {
    const text = 'huntgry://pair?v=1&relay=https%3A%2F%2Frelay.example.com&room=r&pairing=p&pk=' + 'ab'.repeat(32) + '&s=' + 'cd'.repeat(32) + '&exp=1'
    const url = renderQrSvg(text)
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/)
    const svg = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8')
    expect(svg).toContain('<svg')
    expect(svg).not.toContain('cd'.repeat(32))
    expect(url).not.toContain('cd'.repeat(32))
  })

  it('a hello consumes the secret and waits for the owner: nothing is registered or written before Approve', async () => {
    const { pairingId, invite } = await scanned()
    const { frame } = phoneHello(invite, 'Ashish’s iPhone 17')
    expect(await manager.receive(frame)).toBe(true)
    expect(acks).toEqual([frame.ref])
    expect(manager.list()[0]).toMatchObject({ id: pairingId, status: 'scanned', deviceName: 'Ashish’s iPhone 17', appVersion: '1.0.0' })
    expect(calls.filter((c) => !c.startsWith('registerPairing'))).toEqual([])
    expect(sent).toEqual([])
    expect(devices.list()).toEqual([])
  })

  it('Approve registers the token hash, then writes the device record, then sends pair.ok with deviceId, relayToken and sid', async () => {
    const { pairingId, invite } = await scanned()
    const { keys, frame } = phoneHello(invite, 'Ashish’s iPhone 17')
    await manager.receive(frame)
    now += 30_000
    const record = await manager.approve(pairingId)

    const [ok] = sent
    const message = answer(invite, ok, keys)
    expect(message.pair).toBe('ok')
    // Only that phone reads it: the QR secret alone (anyone who saw the code) does not open it.
    expect(openPairMessage(ok, invite.secret)).toBeNull()
    const pairOk = (message as Extract<PairMessage, { pair: 'ok' }>).ok
    expect(pairOk.relayToken).toMatch(/^[0-9a-f]{64}$/)
    expect(pairOk).toMatchObject({ deviceId: record.id, sid: record.sid, desktopName: 'Ashish’s Mac', protocol: { min: 1, max: 1 } })
    expect(calls.slice(1)).toEqual([`registerDevice(${record.id},${sha256Hex(pairOk.relayToken)})`, `add(${record.id})`, `send(${pairingId})`])

    // The record: id, name, public key, relay token hash, paired at.
    const onDisk = JSON.parse(await readFile(devices.file, 'utf8')).devices
    expect(onDisk).toEqual([
      { id: record.id, name: 'Ashish’s iPhone 17', publicKey: toBase64(keys.publicKey), tokenHash: sha256Hex(pairOk.relayToken), sid: pairOk.sid, pairedAt: new Date(now).toISOString(), lastSeq: 0, categories: [], needsRepair: false }
    ])
    expect(JSON.stringify(onDisk)).not.toContain(pairOk.relayToken)
    expect(manager.list()[0].status).toBe('paired')
  })

  it('Deny tells the phone and keeps nothing', async () => {
    const { pairingId, invite } = await scanned()
    await manager.receive(phoneHello(invite).frame)
    await manager.deny(pairingId)
    expect(answer(invite, sent[0])).toEqual({ pair: 'denied', reason: 'denied' })
    expect(calls.some((c) => c.startsWith('registerDevice') || c.startsWith('add'))).toBe(false)
    expect(devices.list()).toEqual([])
    expect(manager.list()[0].status).toBe('denied')
    await expect(manager.approve(pairingId)).rejects.toThrow(/no longer waiting/)
  })

  it('the secret is single use: a second hello while the owner decides is ignored, after the decision it is refused as expired', async () => {
    const { pairingId, invite } = await scanned()
    await manager.receive(phoneHello(invite, 'First').frame)
    const intruder = phoneHello(invite, 'Second')
    expect(await manager.receive(intruder.frame)).toBe(true)
    expect(sent).toEqual([])
    expect(manager.list()[0].deviceName).toBe('First')

    await manager.approve(pairingId)
    expect(devices.list().map((d) => d.name)).toEqual(['First'])
    const again = phoneHello(invite, 'Third')
    expect(await manager.receive(again.frame)).toBe(true)
    expect(answer(invite, sent[1])).toEqual({ pair: 'denied', reason: 'expired' })
    expect(devices.list()).toHaveLength(1)
  })

  it('a hello after the QR expired is refused as expired and never reaches the owner', async () => {
    const { pairingId, invite } = await scanned()
    now = invite.exp * 1000
    expect(manager.list()[0].status).toBe('expired')
    expect(await manager.receive(phoneHello(invite).frame)).toBe(true)
    expect(answer(invite, sent[0])).toEqual({ pair: 'denied', reason: 'expired' })
    await expect(manager.approve(pairingId)).rejects.toThrow(/no longer waiting/)
    expect(devices.list()).toEqual([])
  })

  it('a request not decided before the relay forgets the pairing is dropped', async () => {
    const { pairingId, invite } = await scanned()
    await manager.receive(phoneHello(invite).frame)
    now = (invite.exp + APPROVAL_SECONDS) * 1000
    await expect(manager.approve(pairingId)).rejects.toThrow(/no longer waiting/)
    expect(manager.list()).toEqual([])
    // Its secret is gone too: a late frame opens with nothing.
    expect(await manager.receive(phoneHello(invite).frame)).toBe(false)
  })

  it('ignores a frame sealed with another secret (no ack, left to the caller)', async () => {
    await scanned()
    const other: PairingInvite = { ...parsePairingUrl(qrText, now), secret: new Uint8Array(32).fill(7) }
    const { frame } = phoneHello(other)
    expect(await manager.receive(frame)).toBe(false)
    expect(acks).toEqual([])
    expect(manager.list()[0].status).toBe('waiting')
  })

  it('a failed registration writes nothing and leaves the request open; Approve again succeeds', async () => {
    const { pairingId, invite } = await scanned()
    await manager.receive(phoneHello(invite).frame)
    relayDown = true
    await expect(manager.approve(pairingId)).rejects.toThrow(/503/)
    expect(devices.list()).toEqual([])
    expect(sent).toEqual([])
    expect(manager.list()[0]).toMatchObject({ status: 'scanned', error: expect.stringMatching(/503/) })
    relayDown = false
    await manager.approve(pairingId)
    expect(devices.list()).toHaveLength(1)
  })

  it('Approve while offline is refused before anything is registered; pair.ok lost to a drop undoes the record', async () => {
    const { pairingId, invite } = await scanned()
    await manager.receive(phoneHello(invite).frame)
    online = false
    await expect(manager.approve(pairingId)).rejects.toThrow(/not connected/)
    expect(calls.filter((c) => c.startsWith('registerDevice'))).toEqual([])

    online = true
    const send = manager['deps'].send
    manager['deps'].send = async () => false
    await expect(manager.approve(pairingId)).rejects.toThrow(/dropped/)
    const id = calls.find((c) => c.startsWith('registerDevice'))!.slice('registerDevice('.length).split(',')[0]
    expect(calls).toContain(`remove(${id})`)
    expect(calls).toContain(`unregisterDevice(${id})`)
    expect(devices.list()).toEqual([])
    manager['deps'].send = send
  })

  it('a phone pairing again with the same key replaces its old record and token (also one marked needs re-pair)', async () => {
    const keys = generateKeyPair()
    const first = await scanned()
    await manager.receive(phoneHello(first.invite, 'iPhone', keys).frame)
    const old = await manager.approve(first.pairingId)
    await devices.markAllNeedsRepair()

    const second = await scanned()
    await manager.receive(phoneHello(second.invite, 'iPhone', keys).frame)
    const record = await manager.approve(second.pairingId)
    expect(record.sid).not.toBe(old.sid)
    expect(devices.list().map((d) => d.id)).toEqual([record.id])
    expect(calls).toContain(`remove(${old.id})`)
    expect(calls).toContain(`unregisterDevice(${old.id})`)
    expect(calls).not.toContain(`unregisterDevice(${record.id})`)
  })

  it('two overlapping approvals for the same phone key keep the newer record and its token', async () => {
    const keys = generateKeyPair()
    const first = await scanned()
    await manager.receive(phoneHello(first.invite, 'iPhone', keys).frame)
    const second = await scanned()
    await manager.receive(phoneHello(second.invite, 'iPhone', keys).frame)

    const [a, b] = await Promise.all([manager.approve(first.pairingId), manager.approve(second.pairingId)])
    const added = calls.filter((c) => c.startsWith('add(')).map((c) => c.slice('add('.length, -1))
    const [older, newer] = added[0] === a.id ? [a, b] : [b, a]
    expect(devices.list().map((d) => d.id)).toEqual([newer.id])
    expect(calls).toContain(`unregisterDevice(${older.id})`)
    expect(calls).not.toContain(`unregisterDevice(${newer.id})`)
  })

  it('a pairing withdrawn, expired or moved to another room while the relay registers the token is rolled back, and no pair.ok is sent', async () => {
    const invalidations: [string, () => void][] = [
      ['cancelAll', () => manager.cancelAll()],
      ['relay expiry', () => void (now += (PAIRING_TTL_SECONDS + APPROVAL_SECONDS) * 1000)],
      ['room replaced', () => void (roomId = 'room-2')]
    ]
    for (const [label, invalidate] of invalidations) {
      now = T0
      roomId = 'room-1'
      calls = []
      const { pairingId, invite } = await scanned()
      await manager.receive(phoneHello(invite).frame)
      duringRegister = invalidate
      await expect(manager.approve(pairingId), label).rejects.toThrow(/expired or was withdrawn|identity changed/)
      duringRegister = null
      const id = calls.find((c) => c.startsWith('registerDevice'))!.slice('registerDevice('.length).split(',')[0]
      expect(calls, label).toContain(`unregisterDevice(${id})`)
      expect(calls.some((c) => c.startsWith('add(') || c.startsWith('send(')), label).toBe(false)
      expect(devices.list(), label).toEqual([])
      expect(sent, label).toEqual([])
      manager.cancelAll()
    }
  })

  it('closing the modal withdraws an unscanned code but keeps a scanned request', async () => {
    const first = await scanned()
    manager.cancel(first.pairingId)
    expect(manager.list()).toEqual([])
    expect(await manager.receive(phoneHello(first.invite).frame)).toBe(false)

    const second = await scanned()
    await manager.receive(phoneHello(second.invite).frame)
    manager.cancel(second.pairingId)
    expect(manager.list()[0].status).toBe('scanned')
  })

  it('refuses to show a code without credentials or a connection', async () => {
    online = false
    await expect(manager.start()).rejects.toThrow(/not connected/)
    expect(calls).toEqual([])
  })
})
