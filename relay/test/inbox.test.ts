import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LIMITS, type RelayFrame, type RelayNotice } from '@huntgry/remote-protocol'
import { Relay, ciphertext, fixture, frame, randomId, sleep } from './harness'

/** Opaque forwarding, size limit, per-direction inboxes with deliverySeq, acks, ttl, the 50-frame cap, rate limit. */
let relay: Relay
beforeAll(async () => {
  relay = await Relay.start()
}, 60_000)
afterAll(() => relay.dispose())

describe('forwarding', () => {
  it('forwards ct and nonce unchanged, keeps ttl, strips the relay-only fields', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    const phone = await f.phone()
    await phone.next() // presence

    const cmd = frame('desktop', 'cmd-1', { ttl: 7200, ack: 'older' })
    phone.send(cmd)
    const got = await desktop.next<RelayFrame>()
    expect(got).toEqual({ to: 'desktop', ref: 'cmd-1', nonce: cmd.nonce, ct: cmd.ct, ttl: 7200 })

    const result = frame(f.deviceId, 'cmd-1', { ack: 'cmd-1', pushHint: 'needs-reply', pushText: 'Role · Company' })
    desktop.send(result)
    const back = await phone.next<RelayFrame>()
    expect(back).toEqual({ to: f.deviceId, ref: 'cmd-1', nonce: result.nonce, ct: result.ct })
    await desktop.close()
    await phone.close()
  })

  it('rejects a frame over LIMITS.frameBytes with a tooLarge notice and keeps the socket', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    const phone = await f.phone()
    await phone.next()
    phone.send(frame('desktop', 'big', { ct: ciphertext(LIMITS.frameBytes) }))
    const notice = await phone.next<RelayNotice>()
    expect(notice).toMatchObject({ tooLarge: true, ref: 'big' })
    expect((notice as { bytes: number }).bytes).toBeGreaterThan(LIMITS.frameBytes)
    await desktop.expectNone()
    phone.send(frame('desktop', 'small'))
    expect((await desktop.next<RelayFrame>()).ref).toBe('small')
    await desktop.close()
    await phone.close()
  })

  it('lets a phone address only the desktop, and drops desktop frames to unknown devices', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    const phone = await f.phone()
    await phone.next()
    phone.send(frame('other-device', 'x'))
    expect((await phone.closed).code).toBe(1008)
    desktop.send(frame('nobody', 'y'))
    await desktop.expectNone()
    desktop.send(frame('desktop', 'z'))
    await desktop.expectNone()
    expect(desktop.isClosed).toBe(false)
    await desktop.close()
  })
})

describe('inbox', () => {
  it('keeps a frame until its ref is acked, then deletes it (both ack forms)', async () => {
    const f = await fixture(relay)
    const phone = await f.phone()
    await phone.next()
    let desktop = await f.desktop()
    await phone.next() // presence online
    phone.send(frame('desktop', 'c1'))
    phone.send(frame('desktop', 'c2'))
    expect((await desktop.next<RelayFrame>()).ref).toBe('c1')
    expect((await desktop.next<RelayFrame>()).ref).toBe('c2')
    await desktop.close()
    await phone.next() // presence offline

    // Not acked: both come back on reconnect.
    desktop = await f.desktop()
    await phone.next()
    expect((await desktop.next<RelayFrame>()).ref).toBe('c1')
    expect((await desktop.next<RelayFrame>()).ref).toBe('c2')
    desktop.send({ ack: 'c1' }) // ack-only client frame
    desktop.send(frame(f.deviceId, 'c2', { ack: 'c2' })) // result carrying the ack
    expect((await phone.next<RelayFrame>()).ref).toBe('c2')
    await desktop.close()
    await phone.next()

    desktop = await f.desktop()
    await phone.next()
    await desktop.expectNone()

    // The phone's inbox works the same way: the result is redelivered until acked.
    await phone.close()
    let phone2 = await f.phone()
    await phone2.next()
    expect((await phone2.next<RelayFrame>()).ref).toBe('c2')
    phone2.send({ ack: 'c2' })
    await phone2.close()
    phone2 = await f.phone()
    await phone2.next()
    await phone2.expectNone()
    await desktop.close()
    await phone2.close()
  })

  it('tells the phone a frame was queued while the desktop is offline', async () => {
    const f = await fixture(relay)
    const phone = await f.phone()
    expect(await phone.next<RelayNotice>()).toMatchObject({ presence: 'offline', queued: 0 })
    phone.send(frame('desktop', 'q1'))
    expect(await phone.next<RelayNotice>()).toEqual({ queued: true, ref: 'q1' })
    const desktop = await f.desktop()
    expect(await phone.next<RelayNotice>()).toMatchObject({ presence: 'online', queued: 1 })
    expect((await desktop.next<RelayFrame>()).ref).toBe('q1')
    await desktop.close()
    await phone.close()
  })

  it('redelivers unacked frames in deliverySeq order before live frames after a disconnect', async () => {
    const f = await fixture(relay)
    const phone = await f.phone()
    await phone.next()
    let desktop = await f.desktop()
    await phone.next()
    phone.send(frame('desktop', 'a'))
    phone.send(frame('desktop', 'b'))
    expect((await desktop.next<RelayFrame>()).ref).toBe('a')
    expect((await desktop.next<RelayFrame>()).ref).toBe('b')
    await desktop.close() // before acking anything
    await phone.next() // offline
    phone.send(frame('desktop', 'c'))
    expect(await phone.next<RelayNotice>()).toEqual({ queued: true, ref: 'c' })

    desktop = await f.desktop()
    await phone.next() // online
    phone.send(frame('desktop', 'd')) // live, arrives while the backlog is being replayed
    const refs = [] as string[]
    for (let i = 0; i < 4; i++) refs.push((await desktop.next<RelayFrame>()).ref)
    expect(refs).toEqual(['a', 'b', 'c', 'd'])
    desktop.send({ ack: 'a' })
    desktop.send({ ack: 'b' })
    await desktop.close()
    await phone.next()
    desktop = await f.desktop()
    await phone.next()
    expect((await desktop.next<RelayFrame>()).ref).toBe('c')
    expect((await desktop.next<RelayFrame>()).ref).toBe('d')
    await desktop.close()
    await phone.close()
  })

  it('drops a frame when its ttl passes and tells the sender, live or on its next connection', async () => {
    const f = await fixture(relay)
    let phone = await f.phone()
    await phone.next()
    phone.send(frame('desktop', 'live', { ttl: 1 }))
    expect(await phone.next<RelayNotice>()).toEqual({ queued: true, ref: 'live' })
    expect(await phone.next<RelayNotice>(2500)).toEqual({ expired: true, ref: 'live' })

    phone.send(frame('desktop', 'later', { ttl: 1 }))
    await phone.next()
    await phone.close()
    await sleep(1500)
    phone = await f.phone()
    await phone.next() // presence
    expect(await phone.next<RelayNotice>()).toEqual({ expired: true, ref: 'later' })
    const desktop = await f.desktop()
    await phone.next()
    await desktop.expectNone()
    await desktop.close()
    await phone.close()
  })

  it('holds at most 50 unacked frames per phone, dropping the oldest events but never results', async () => {
    const f = await fixture(relay)
    const phone = await f.phone()
    await phone.next()
    const desktop = await f.desktop()
    await phone.next()
    phone.send(frame('desktop', 'cmd-x'))
    expect((await desktop.next<RelayFrame>()).ref).toBe('cmd-x')
    await phone.close()

    desktop.send(frame(f.deviceId, 'cmd-x', { ack: 'cmd-x' })) // the result, first in line
    for (let i = 0; i < 55; i++) desktop.send(frame(f.deviceId, `ev-${i}`))
    await sleep(300)

    const phone2 = await f.phone()
    await phone2.next()
    const refs: string[] = []
    for (let i = 0; i < 50; i++) refs.push((await phone2.next<RelayFrame>()).ref)
    await phone2.expectNone()
    expect(refs[0]).toBe('cmd-x')
    expect(refs.slice(1)).toEqual(Array.from({ length: 49 }, (_, i) => `ev-${i + 6}`))
    await desktop.close()
    await phone2.close()
  })

  it('closes a connection that sends more than 60 frames a minute', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    for (let i = 0; i < 61; i++) desktop.send({ ack: randomId('n') })
    const closed = await desktop.closed
    expect(closed.code).toBe(1008)
    expect(closed.reason).toBe('rate limited')
  })
})
