import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RelayNotice } from '@huntgry/remote-protocol'
import { Relay, fixture, frame, sleep } from './harness'

/** `{ presence, since, queued }` to phones; the desktop is offline after two missed heartbeats. */
let relay: Relay
beforeAll(async () => {
  relay = await Relay.start({ bindings: { HEARTBEAT_SECONDS: '1' } })
}, 60_000)
afterAll(() => relay.dispose())

describe('presence', () => {
  it('reports offline on connect, online when the desktop arrives, offline when it leaves', async () => {
    const f = await fixture(relay)
    const phone = await f.phone()
    const first = await phone.next<RelayNotice>()
    expect(first).toMatchObject({ presence: 'offline', queued: 0 })
    expect(Date.parse((first as { since: string }).since)).toBeGreaterThan(0)

    const desktop = await f.desktop()
    const online = await phone.next<RelayNotice>()
    expect(online).toMatchObject({ presence: 'online', queued: 0 })
    expect(Date.parse((online as { since: string }).since)).toBeGreaterThanOrEqual(Date.parse((first as { since: string }).since))

    await desktop.close()
    expect(await phone.next<RelayNotice>()).toMatchObject({ presence: 'offline' })

    // A phone connecting later sees the current state and its own queued count.
    phone.send(frame('desktop', 'q'))
    await phone.next() // queued
    await phone.close()
    const again = await f.phone()
    expect(await again.next<RelayNotice>()).toMatchObject({ presence: 'offline', queued: 1 })
    await again.close()
  })

  it('counts the desktop as offline after two missed heartbeats and closes its socket', async () => {
    const f = await fixture(relay)
    const phone = await f.phone()
    await phone.next()
    const desktop = await f.desktop()
    await phone.next() // online
    // Any frame counts as a heartbeat: keep it alive past the 2 s window first.
    await sleep(1200)
    desktop.send({ ack: 'noop' })
    await sleep(1200)
    expect(desktop.isClosed).toBe(false)
    // Then go silent.
    const closed = await desktop.closed
    expect(closed.code).toBe(4005)
    expect(await phone.next<RelayNotice>(4000)).toMatchObject({ presence: 'offline' })
    await phone.close()
  })
})
