import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RelayFrame } from '@huntgry/remote-protocol'
import { PUSH_BODIES, PUSH_TITLE } from '../src/push'
import { Relay, fixture, frame, sleep, type Fixture } from './harness'

/** Push token lifecycle, push on pushHint only when the phone has no socket, coalescing, revocation. */
let relay: Relay
const flakySeen = new Set<string>()
beforeAll(async () => {
  relay = await Relay.start({
    bindings: { PUSH_RECEIPT_DELAY_SECONDS: '1' },
    // A ticket error for "dead" tokens; an ok ticket with an id otherwise (the id names the token).
    pushReply: (call) => ({
      data: call.body.map((m) =>
        m.to.includes('[dead')
          ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : m.to.includes('[flaky') && !flakySeen.has(m.to) && flakySeen.add(m.to)
            ? { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } } // fails once per token
            : { status: 'ok', id: `ticket-${m.to}-${Date.now()}` }
      )
    }),
    // The receipt, fetched later, reports "late-dead" tokens as gone.
    receiptReply: (ids) => ({ data: Object.fromEntries(ids.map((id) => [id, id.includes('late-dead') ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }])) })
  })
}, 60_000)
afterAll(() => relay.dispose())

const TOKEN = 'ExponentPushToken[abcDEF123_-]'

async function registered(f: Fixture, token = TOKEN): Promise<void> {
  const phone = await f.phone()
  await phone.next()
  phone.send({ pushToken: token })
  await sleep(100)
  await phone.close()
}

async function waitForPushes(n: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (relay.pushes.length < n && Date.now() - start < timeoutMs) await sleep(25)
}

describe('push', () => {
  it('is sent for a pushHint only when the phone has no socket, with the fixed body and data.category', async () => {
    const f = await fixture(relay)
    await registered(f)
    const desktop = await f.desktop()
    const phone = await f.phone()
    await phone.next()
    const before = relay.pushes.length
    desktop.send(frame(f.deviceId, 'e1', { pushHint: 'needs-reply' }))
    expect((await phone.next<RelayFrame>()).ref).toBe('e1')
    await sleep(200)
    expect(relay.pushes.length).toBe(before)

    await phone.close()
    desktop.send(frame(f.deviceId, 'e2', { pushHint: 'pipeline-finished' }))
    await waitForPushes(before + 1)
    const call = relay.pushes[before]
    expect(call.url).toBe('https://exp.host/--/api/v2/push/send')
    expect(call.body).toEqual([{ to: TOKEN, title: PUSH_TITLE, body: PUSH_BODIES['pipeline-finished'], data: { category: 'pipeline-finished' }, sound: 'default', priority: 'high', channelId: 'pipeline-finished' }])

    // Without a hint nothing is pushed, with pushText the text is the body.
    desktop.send(frame(f.deviceId, 'e3'))
    desktop.send(frame(f.deviceId, 'e4', { pushHint: 'needs-review', pushText: 'Senior Engineer · Acme' }))
    await waitForPushes(before + 2)
    await sleep(200)
    expect(relay.pushes.length).toBe(before + 2)
    expect(relay.pushes[before + 1].body[0]).toMatchObject({ body: 'Senior Engineer · Acme', data: { category: 'needs-review' } })
    await desktop.close()
  })

  it('coalesces to one push per category per window and device', async () => {
    const f = await fixture(relay)
    await registered(f)
    const desktop = await f.desktop()
    const before = relay.pushes.length
    desktop.send(frame(f.deviceId, 'r1', { pushHint: 'failed' }))
    desktop.send(frame(f.deviceId, 'r2', { pushHint: 'failed' }))
    desktop.send(frame(f.deviceId, 'r3', { pushHint: 'usage-limit' }))
    await waitForPushes(before + 2)
    await sleep(200)
    expect(relay.pushes.slice(before).map((c) => c.body[0].data.category)).toEqual(['failed', 'usage-limit'])
    await desktop.close()

    // With a 1 s window the second push of a category goes out again.
    const short = await Relay.start({ bindings: { PUSH_COALESCE_SECONDS: '1' } })
    try {
      const g = await fixture(short)
      const phone = await g.phone()
      await phone.next()
      phone.send({ pushToken: TOKEN })
      await sleep(100)
      await phone.close()
      const d = await g.desktop()
      d.send(frame(g.deviceId, 's1', { pushHint: 'failed' }))
      await sleep(1100)
      d.send(frame(g.deviceId, 's2', { pushHint: 'failed' }))
      await sleep(400)
      expect(short.pushes.length).toBe(2)
      await d.close()
    } finally {
      await short.dispose()
    }
  })

  it('checks the token shape, replaces the previous token, deletes it on null', async () => {
    const f = await fixture(relay)
    const bad = await f.phone()
    await bad.next()
    bad.send({ pushToken: 'not-a-token' })
    expect((await bad.closed).code).toBe(1008)
    const bad2 = await f.phone()
    await bad2.next()
    bad2.send({ pushToken: 'ExponentPushToken[]' })
    expect((await bad2.closed).code).toBe(1008)

    await registered(f, 'ExponentPushToken[first]')
    await registered(f, 'ExpoPushToken[second]')
    const desktop = await f.desktop()
    const before = relay.pushes.length
    desktop.send(frame(f.deviceId, 'p1', { pushHint: 'needs-reply' }))
    await waitForPushes(before + 1)
    expect(relay.pushes[before].body[0].to).toBe('ExpoPushToken[second]')

    const phone = await f.phone()
    await phone.next()
    await phone.next() // p1 redelivered
    phone.send({ pushToken: null })
    await sleep(100)
    await phone.close()
    desktop.send(frame(f.deviceId, 'p2', { pushHint: 'pipeline-finished' }))
    await sleep(300)
    expect(relay.pushes.length).toBe(before + 1)
    await desktop.close()
  })

  it('only a paired phone may register a token', async () => {
    const f = await fixture(relay)
    const desktop = await f.desktop()
    desktop.send({ pushToken: TOKEN })
    expect((await desktop.closed).code).toBe(1008)
    expect(await relay.registerPairing(f.roomId, f.ownerSecret, 'pair-1')).toBe(201)
    const pairing = await relay.connectAs(f.roomId, { room: f.roomId, pairing: 'pair-1' })
    await pairing.next()
    pairing.send({ pushToken: TOKEN })
    expect((await pairing.closed).code).toBe(1008)
  })

  it('deletes the token after a DeviceNotRegistered ticket', async () => {
    const f = await fixture(relay)
    await registered(f, 'ExponentPushToken[dead-token]')
    const desktop = await f.desktop()
    const before = relay.pushes.length
    desktop.send(frame(f.deviceId, 'd1', { pushHint: 'failed' }))
    await waitForPushes(before + 1)
    await sleep(200)
    desktop.send(frame(f.deviceId, 'd2', { pushHint: 'needs-reply' }))
    await sleep(300)
    expect(relay.pushes.length).toBe(before + 1)
    await desktop.close()
  })
})

describe('push failures', () => {
  it('do not count for coalescing: the next hint in the category tries again', async () => {
    const f = await fixture(relay)
    await registered(f, 'ExponentPushToken[flaky-token]')
    const desktop = await f.desktop()
    const before = relay.pushes.length
    desktop.send(frame(f.deviceId, 'f1', { pushHint: 'failed' }))
    await waitForPushes(before + 1)
    await sleep(200)
    desktop.send(frame(f.deviceId, 'f2', { pushHint: 'failed' }))
    await waitForPushes(before + 2)
    expect(relay.pushes).toHaveLength(before + 2)
    // That one succeeded, so the window holds again.
    await sleep(200)
    desktop.send(frame(f.deviceId, 'f3', { pushHint: 'failed' }))
    await sleep(400)
    expect(relay.pushes).toHaveLength(before + 2)
    await desktop.close()
  })
})

describe('push receipts', () => {
  it('deletes the token when the receipt fetched after an ok ticket says DeviceNotRegistered', async () => {
    const f = await fixture(relay)
    await registered(f, 'ExponentPushToken[late-dead]')
    const desktop = await f.desktop()
    const before = relay.pushes.length
    const receiptsBefore = relay.receipts.length
    desktop.send(frame(f.deviceId, 'l1', { pushHint: 'failed' }))
    await waitForPushes(before + 1)
    expect(relay.pushes).toHaveLength(before + 1)

    const start = Date.now()
    while (!relay.receipts.slice(receiptsBefore).some((ids) => ids.some((id) => id.includes('late-dead'))) && Date.now() - start < 5000) await sleep(50)
    expect(relay.receipts.slice(receiptsBefore).flat().filter((id) => id.includes('late-dead'))).toHaveLength(1)
    await sleep(200)

    // Another category is not coalesced away, so only the cleared token explains no push.
    desktop.send(frame(f.deviceId, 'l2', { pushHint: 'needs-reply' }))
    await sleep(400)
    expect(relay.pushes).toHaveLength(before + 1)
    await desktop.close()
  })

  it('keeps a token whose receipt is ok, and asks for each ticket once', async () => {
    const f = await fixture(relay)
    await registered(f, 'ExponentPushToken[alive-token]')
    const desktop = await f.desktop()
    const before = relay.pushes.length
    desktop.send(frame(f.deviceId, 'a1', { pushHint: 'failed' }))
    await waitForPushes(before + 1)
    await sleep(2500)
    expect(relay.receipts.flat().filter((id) => id.includes('alive-token'))).toHaveLength(1)
    desktop.send(frame(f.deviceId, 'a2', { pushHint: 'needs-reply' }))
    await waitForPushes(before + 2)
    expect(relay.pushes).toHaveLength(before + 2)
    await desktop.close()
  })
})

describe('revocation', () => {
  it('deletes the token hash, push token and inbox, and closes the socket', async () => {
    const f = await fixture(relay)
    await registered(f)
    const desktop = await f.desktop()
    const phone = await f.phone()
    await phone.next()
    phone.send(frame('desktop', 'cmd-1'))
    expect((await desktop.next<RelayFrame>()).ref).toBe('cmd-1')
    desktop.send(frame(f.deviceId, 'cmd-1', { ack: 'cmd-1' }))
    expect((await phone.next<RelayFrame>()).ref).toBe('cmd-1') // unacked on the phone

    expect(await relay.revokeDevice(f.roomId, f.ownerSecret, f.deviceId)).toBe(204)
    expect((await phone.closed).code).toBe(4001)
    expect((await f.phone().then((c) => c.closed)).code).toBe(4002)

    const before = relay.pushes.length
    desktop.send(frame(f.deviceId, 'after', { pushHint: 'needs-reply' }))
    await sleep(300)
    expect(relay.pushes.length).toBe(before)

    // Re-registering the same id starts from an empty inbox.
    expect(await relay.registerDevice(f.roomId, f.ownerSecret, f.deviceId, f.relayToken)).toBe(201)
    const again = await f.phone()
    await again.next()
    await again.expectNone()
    await desktop.close()
    await again.close()
  })
})
