import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveSessionKey, toBase64 } from '@shared/remote'
import { DeviceStore } from './devices'
import { fakeCipher, fakePhone } from './test-helpers'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-devices-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('DeviceStore', () => {
  it('generates the desktop keypair once, encrypted, and derives the same session key as the phone', async () => {
    const store = new DeviceStore(dir, fakeCipher())
    await store.load()
    const keys = (await store.keyPair())!
    const raw = await readFile(join(dir, 'desktop-key.json'), 'utf8')
    expect(raw).not.toContain(toBase64(keys.secretKey))
    expect(JSON.parse(raw).publicKey).toBe(toBase64(keys.publicKey))
    const phone = fakePhone(keys)
    await store.add(phone.record)
    const again = new DeviceStore(dir, fakeCipher())
    await again.load()
    expect(toBase64((await again.keyPair())!.publicKey)).toBe(toBase64(keys.publicKey))
    expect(await again.sessionKey(phone.id)).toEqual(deriveSessionKey(phone.keys.publicKey, keys.secretKey))
    expect(await again.sessionKey(phone.id)).toEqual(phone.sessionKey)
  })

  it('checkpoints lastSeq, lastSeen and the outgoing seq atomically and never lowers lastSeq', async () => {
    const store = new DeviceStore(dir, fakeCipher())
    await store.load()
    const phone = fakePhone((await store.keyPair())!)
    await store.add(phone.record)
    await store.accept(phone.id, 7, '2026-09-30T01:00:00.000Z')
    await store.accept(phone.id, 5, '2026-09-30T01:00:01.000Z')
    const a = store.nextOutSeq()
    const b = store.nextOutSeq()
    expect([a.seq, b.seq]).toEqual([1, 2])
    await Promise.all([a.persisted, b.persisted])
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const file = JSON.parse(await readFile(join(dir, 'devices.json'), 'utf8'))
    expect(file.outSeq).toBe(2)
    expect(file.devices[0]).toMatchObject({ id: phone.id, lastSeq: 7, lastSeen: '2026-09-30T01:00:01.000Z' })
    const again = new DeviceStore(dir, fakeCipher())
    await again.load()
    expect(again.get(phone.id)!.lastSeq).toBe(7)
    expect(again.currentOutSeq()).toBe(2)
    again.raiseLastSeq(phone.id, 3)
    expect(again.get(phone.id)!.lastSeq).toBe(7)
    again.raiseLastSeq(phone.id, 30)
    expect(again.get(phone.id)!.lastSeq).toBe(30)
  })

  it('marks a device for re-pair and rotation drops every device', async () => {
    const store = new DeviceStore(dir, fakeCipher())
    await store.load()
    const keys = (await store.keyPair())!
    await store.add(fakePhone(keys, 'A', 'dev-a').record)
    await store.add(fakePhone(keys, 'B', 'dev-b').record)
    await store.markNeedsRepair('dev-a')
    expect(store.active().map((d) => d.id)).toEqual(['dev-b'])
    const rotated = await store.rotateKeyPair()
    expect(toBase64(rotated.publicKey)).not.toBe(toBase64(keys.publicKey))
    expect(store.list()).toEqual([])
    const again = new DeviceStore(dir, fakeCipher())
    await again.load()
    expect(again.list()).toEqual([])
    expect(toBase64((await again.keyPair())!.publicKey)).toBe(toBase64(rotated.publicKey))
  })
})
