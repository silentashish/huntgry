import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HttpReply, NETWORK_ERROR, Relay, fixture, frame, sleep, type Fixture } from './harness'

/**
 * #70: bounded retries for transient Expo push failures. One relay, 1-second retry delays
 * (budget 3). The token's name picks how the fake Expo endpoint behaves:
 *   [once-N]   MessageRateExceeded on the first call, ok after
 *   [net-N]    network error on the first call, ok after
 *   [limit-N]  429 with Retry-After: 2 on the first call, ok after
 *   [down-N]   503 every time
 *   [bad-N]    400 every time (permanent: no retry)
 *   [dying-N]  503 first, then DeviceNotRegistered
 *   [twin-N]   429 twice with the same Retry-After date, then DeviceNotRegistered, ok after
 */
let relay: Relay
const calls = new Map<string, number>()
const retryDates = new Map<string, string>()
beforeAll(async () => {
  relay = await Relay.start({
    bindings: { PUSH_RETRY_DELAYS_SECONDS: '1,1,1', PUSH_RECEIPT_DELAY_SECONDS: '600' },
    pushReply: (call) => {
      const to = call.body[0].to
      const n = (calls.get(to) ?? 0) + 1
      calls.set(to, n)
      const ok = { data: [{ status: 'ok', id: `ticket-${n}-${Date.now()}` }] }
      if (to.includes('[once-')) return n === 1 ? { data: [{ status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } }] } : ok
      if (to.includes('[net-')) return n === 1 ? NETWORK_ERROR : ok
      if (to.includes('[limit-')) return n === 1 ? new HttpReply(429, { 'retry-after': '2' }) : ok
      if (to.includes('[down-')) return new HttpReply(503)
      if (to.includes('[bad-')) return new HttpReply(400)
      if (to.includes('[dying-')) return n === 1 ? new HttpReply(503) : { data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }
      if (to.includes('[twin-')) {
        if (!retryDates.has(to)) retryDates.set(to, new Date(Math.ceil(Date.now() / 1000) * 1000 + 3000).toUTCString())
        if (n <= 2) return new HttpReply(429, { 'retry-after': retryDates.get(to)! })
        return n === 3 ? { data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] } : ok
      }
      return ok
    }
  })
}, 60_000)
afterAll(() => relay.dispose())

let counter = 0
const token = (kind: string): string => `ExponentPushToken[${kind}-${++counter}]`

async function withToken(f: Fixture, pushToken: string | null): Promise<void> {
  const phone = await f.phone()
  await phone.next() // presence
  phone.send({ pushToken })
  await sleep(100)
  await phone.close()
}

const callsTo = (to: string) => relay.pushes.filter((c) => c.body[0].to === to)

async function waitForCalls(to: string, n: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (callsTo(to).length < n && Date.now() - start < timeoutMs) await sleep(50)
}

describe('push retries', () => {
  it('a transient failure followed by success delivers exactly one push', async () => {
    for (const kind of ['once', 'net']) {
      const f = await fixture(relay)
      const t = token(kind)
      await withToken(f, t)
      const desktop = await f.desktop()
      desktop.send(frame(f.deviceId, `${kind}-1`, { pushHint: 'needs-reply' }))
      await waitForCalls(t, 2)
      await sleep(2500) // nothing more after the success
      expect(callsTo(t), kind).toHaveLength(2)
      expect(callsTo(t)[1].body[0].body).toBe('A run needs your reply')
      await desktop.close()
    }
  })

  it('a hint arriving while a retry is pending replaces its body instead of adding a push', async () => {
    const f = await fixture(relay)
    const t = token('once')
    await withToken(f, t)
    const desktop = await f.desktop()
    desktop.send(frame(f.deviceId, 'r1', { pushHint: 'failed', pushText: 'first' }))
    await waitForCalls(t, 1)
    await sleep(200)
    desktop.send(frame(f.deviceId, 'r2', { pushHint: 'failed', pushText: 'second' }))
    await waitForCalls(t, 2)
    await sleep(2500)
    expect(callsTo(t).map((c) => c.body[0].body)).toEqual(['first', 'second'])
    await desktop.close()
  })

  it("honours a 429's Retry-After when it is longer than the backoff", async () => {
    const f = await fixture(relay)
    const t = token('limit')
    await withToken(f, t)
    const desktop = await f.desktop()
    const sentAt = Date.now()
    desktop.send(frame(f.deviceId, 'l1', { pushHint: 'usage-limit' }))
    await waitForCalls(t, 2)
    expect(callsTo(t)).toHaveLength(2)
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1900)
    await desktop.close()
  })

  it('stops after the retry budget: one send and three retries, no storm', async () => {
    const f = await fixture(relay)
    const t = token('down')
    await withToken(f, t)
    const desktop = await f.desktop()
    desktop.send(frame(f.deviceId, 'd1', { pushHint: 'failed' }))
    await waitForCalls(t, 4)
    await sleep(3000)
    expect(callsTo(t)).toHaveLength(4)
    // The spent hint does not block the next one.
    desktop.send(frame(f.deviceId, 'd2', { pushHint: 'failed' }))
    await waitForCalls(t, 5)
    expect(callsTo(t)).toHaveLength(5)
    await desktop.close()
  })

  it('does not retry a permanent failure', async () => {
    const f = await fixture(relay)
    const t = token('bad')
    await withToken(f, t)
    const desktop = await f.desktop()
    desktop.send(frame(f.deviceId, 'b1', { pushHint: 'failed' }))
    await waitForCalls(t, 1)
    await sleep(2500)
    expect(callsTo(t)).toHaveLength(1)
    await desktop.close()
  })
})

describe('push retries are cancelled', () => {
  async function pendingRetry(): Promise<{ f: Fixture; t: string; desktop: Awaited<ReturnType<Fixture['desktop']>> }> {
    const f = await fixture(relay)
    const t = token('down')
    await withToken(f, t)
    const desktop = await f.desktop()
    desktop.send(frame(f.deviceId, 'c1', { pushHint: 'failed' }))
    await waitForCalls(t, 1)
    return { f, t, desktop }
  }

  it('by a new token', async () => {
    const { f, t, desktop } = await pendingRetry()
    await withToken(f, token('fresh'))
    await sleep(2500)
    expect(callsTo(t)).toHaveLength(1)
    await desktop.close()
  })

  it('by { pushToken: null }', async () => {
    const { f, t, desktop } = await pendingRetry()
    await withToken(f, null)
    await sleep(2500)
    expect(callsTo(t)).toHaveLength(1)
    await desktop.close()
  })

  it('by revocation', async () => {
    const { f, t, desktop } = await pendingRetry()
    expect(await relay.revokeDevice(f.roomId, f.ownerSecret, f.deviceId)).toBe(204)
    await sleep(2500)
    expect(callsTo(t)).toHaveLength(1)
    await desktop.close()
  })

  it('by DeviceNotRegistered on a retry, which also clears the token', async () => {
    const f = await fixture(relay)
    const t = token('dying')
    await withToken(f, t)
    const desktop = await f.desktop()
    desktop.send(frame(f.deviceId, 'n1', { pushHint: 'failed' }))
    await waitForCalls(t, 2)
    await sleep(2500)
    expect(callsTo(t)).toHaveLength(2)
    // The token is gone: another category sends nothing.
    desktop.send(frame(f.deviceId, 'n2', { pushHint: 'needs-reply' }))
    await sleep(500)
    expect(callsTo(t)).toHaveLength(2)
    await desktop.close()
  })

  it('by DeviceNotRegistered on an earlier retry of the same alarm', async () => {
    const f = await fixture(relay)
    const t = token('twin')
    await withToken(f, t)
    const desktop = await f.desktop()
    // Two categories are rate limited until the same instant, so one alarm finds both retries due;
    // the first finds the token dead and the second must not go out.
    desktop.send(frame(f.deviceId, 'w1', { pushHint: 'failed' }))
    desktop.send(frame(f.deviceId, 'w2', { pushHint: 'needs-reply' }))
    await waitForCalls(t, 3)
    await sleep(2500)
    expect(callsTo(t)).toHaveLength(3)
    await desktop.close()
  })
})
