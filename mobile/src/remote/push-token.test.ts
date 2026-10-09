/**
 * The `{ pushToken }` path (#39): the relay client sends the clear frame after authentication,
 * again when the token changes, `null` to remove it, and on unpair (`farewell`); the token is
 * never boxed for the desktop.
 */

import { describe, expect, it } from 'vitest'
import { commands } from './commands'
import { RemoteModel } from './model'
import { RelayClient } from './relay'
import { FakeClock, FakeDesktop, PAIRING, SESSION_KEY, STATUS, Sockets, pairedVault, presence, settle } from './test-helpers'
import { VAULT_KEYS } from './vault'

const TOKEN = 'ExponentPushToken[abc-DEF_123]'
const TOKEN_2 = 'ExponentPushToken[rotated_456]'

async function client() {
  const clock = new FakeClock()
  const sockets = new Sockets()
  const { vault } = await pairedVault()
  const fatal: string[] = []
  const c = new RelayClient({
    pairing: PAIRING,
    vault,
    socket: sockets.factory,
    clock,
    random: () => 0.5,
    appVersion: '0.1.0',
    workspaceId: () => STATUS.desktop.workspaceId,
    events: { onEnvelope: () => undefined, onFatal: (r) => void fatal.push(r) }
  })
  const online = async () => {
    sockets.last.open()
    sockets.last.receive(presence())
    await settle()
  }
  /** The clear `{ pushToken }` frames a socket sent, in order. */
  const pushFrames = (i = sockets.all.length - 1) =>
    sockets.all[i].sent.map((t) => JSON.parse(t) as Record<string, unknown>).filter((f) => 'pushToken' in f).map((f) => f.pushToken)
  return { clock, sockets, vault, client: c, online, pushFrames, fatal, desktop: new FakeDesktop(clock) }
}

describe('push token on the relay socket', () => {
  it('sends nothing while the phone has no answer yet (push never asked for)', async () => {
    const t = await client()
    t.client.start()
    await t.online()
    expect(t.pushFrames()).toEqual([])
  })

  it('sends { pushToken } right after auth, before the boxed hello, and never inside an envelope', async () => {
    const t = await client()
    t.client.setPushToken(TOKEN)
    t.client.start()
    await t.online()
    const sent = t.sockets.last.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
    expect(sent[0]).toHaveProperty('auth')
    expect(sent[1]).toEqual({ pushToken: TOKEN })
    expect(sent[2]).toHaveProperty('ct')
    expect(t.sockets.last.envelopes(SESSION_KEY).map((e) => JSON.stringify(e)).join('')).not.toContain('abc-DEF_123')
  })

  it('sends a changed token at once, nothing for the same token, and again after every reconnect', async () => {
    const t = await client()
    t.client.setPushToken(TOKEN)
    t.client.start()
    await t.online()
    t.client.setPushToken(TOKEN)
    await settle()
    t.client.setPushToken(TOKEN_2)
    await settle()
    expect(t.pushFrames()).toEqual([TOKEN, TOKEN_2])

    t.sockets.last.serverClose(1006)
    await t.clock.advance(1_500)
    await t.online()
    expect(t.pushFrames(1)).toEqual([TOKEN_2])
  })

  it('a token set while offline goes out on the next authentication', async () => {
    const t = await client()
    t.client.start()
    t.client.setPushToken(TOKEN)
    await settle()
    expect(t.sockets.last.sent).toEqual([])
    await t.online()
    expect(t.pushFrames()).toEqual([TOKEN])
  })

  it('sends { pushToken: null } when push is turned off', async () => {
    const t = await client()
    t.client.setPushToken(TOKEN)
    t.client.start()
    await t.online()
    t.client.setPushToken(null)
    await settle()
    expect(t.pushFrames()).toEqual([TOKEN, null])
  })

  it('never sends a token the relay would refuse (it closes the socket with 1008)', async () => {
    const t = await client()
    t.client.start()
    await t.online()
    t.client.setPushToken('not-a-token')
    t.client.setPushToken('ExponentPushToken[]')
    await settle()
    expect(t.pushFrames()).toEqual([])
    expect(t.sockets.last.closed).toBeNull()
  })

  it('farewell sends { pushToken: null } on the open socket, then stops', async () => {
    const t = await client()
    t.client.setPushToken(TOKEN)
    t.client.start()
    await t.online()
    expect(await t.client.farewell()).toBe(true)
    expect(t.pushFrames()).toEqual([TOKEN, null])
    expect(t.sockets.last.closed?.code).toBe(1000)
    expect(t.client.connection).toBe('stopped')
  })

  it('farewell while reconnecting connects now and waits for the auth to send null', async () => {
    const t = await client()
    t.client.setPushToken(TOKEN)
    t.client.start()
    await t.online()
    t.sockets.last.serverClose(1006)
    await settle()
    const done = t.client.farewell(4_000)
    await settle()
    expect(t.sockets.all).toHaveLength(2) // reconnected without waiting out the backoff
    await t.online()
    expect(await done).toBe(true)
    expect(t.pushFrames(1)).toEqual([null])
  })

  it('farewell gives up after its timeout when the relay is unreachable', async () => {
    const t = await client()
    t.client.setPushToken(TOKEN)
    t.client.start()
    const done = t.client.farewell(4_000)
    await t.clock.advance(4_000)
    expect(await done).toBe(false)
    expect(t.client.connection).toBe('stopped')
  })

  it('a "pair again" answer removes the token before the socket closes', async () => {
    const t = await client()
    t.client.setPushToken(TOKEN)
    t.client.start()
    await t.online()
    t.sockets.last.receive(t.desktop.event('device.revoked', {}))
    await settle()
    expect(t.fatal).toEqual(['revoked'])
    expect(t.pushFrames()).toEqual([TOKEN, null])
  })
})

describe('background: no live socket, so the relay pushes', () => {
  it('sleep sends pending acks, closes with 1000 and does not reconnect until wake', async () => {
    const t = await client()
    t.client.start()
    await t.online()
    const event = t.desktop.event('status', STATUS)
    t.sockets.last.receive(event)
    await settle()
    const acksBefore = t.sockets.last.acks()
    t.client.sleep()
    expect(t.sockets.last.acks()).toEqual(expect.arrayContaining(acksBefore))
    expect(t.sockets.last.acks()).toContain(event.ref)
    expect(t.sockets.last.closed?.code).toBe(1000)
    await t.clock.advance(10 * 60_000)
    expect(t.sockets.all).toHaveLength(1)

    // A command typed while asleep waits for the foreground.
    t.client.send(commands.status())
    t.client.wake()
    expect(t.sockets.all).toHaveLength(2)
    await t.online()
    expect(t.sockets.last.envelopes().map((e) => e.name ?? e.kind)).toEqual(['hello', 'status.get'])
  })

  it('the model sleeps after a short grace, and a quick return cancels it', async () => {
    const clock = new FakeClock()
    const sockets = new Sockets()
    const { vault } = await pairedVault()
    const m = new RemoteModel({ vault, socket: sockets.factory, clock, appVersion: '0.1.0', deviceName: 'iPhone', random: () => 0.5 })
    await m.init()
    sockets.last.open()
    sockets.last.receive(presence())
    await settle()
    m.background()
    await clock.advance(1_000)
    m.wake()
    await clock.advance(5_000)
    expect(sockets.last.closed).toBeNull()
    m.background()
    await clock.advance(2_000)
    expect(sockets.last.closed?.code).toBe(1000)
    m.wake()
    expect(sockets.all).toHaveLength(2)
  })
})

describe('push token in the model', () => {
  async function model() {
    const clock = new FakeClock()
    const sockets = new Sockets()
    const { vault, storage } = await pairedVault()
    const m = new RemoteModel({ vault, socket: sockets.factory, clock, appVersion: '0.1.0', deviceName: 'iPhone', random: () => 0.5 })
    const pushFrames = () => sockets.last.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => 'pushToken' in f).map((f) => f.pushToken)
    const online = async () => {
      sockets.last.open()
      sockets.last.receive(presence())
      await settle()
    }
    return { clock, sockets, vault, storage, model: m, pushFrames, online }
  }

  it('hands the token to the client it connects with and to the live one', async () => {
    const t = await model()
    t.model.setPushToken(TOKEN)
    await t.model.init()
    await t.online()
    t.model.setPushToken(TOKEN_2)
    await settle()
    expect(t.pushFrames()).toEqual([TOKEN, TOKEN_2])
  })

  it('unpair tells the relay to forget the token, then wipes the vault including the push choice', async () => {
    const t = await model()
    await t.vault.savePushEnabled(true)
    expect(await t.vault.loadPushEnabled()).toBe(true)
    t.model.setPushToken(TOKEN)
    await t.model.init()
    await t.online()
    await t.model.unpair()
    expect(t.pushFrames()).toEqual([TOKEN, null])
    expect(t.model.getSnapshot().phase).toBe('unpaired')
    expect(t.storage.data.has(VAULT_KEYS.push)).toBe(false)
    expect(t.storage.data.size).toBe(0)
  })

  it('stores the push choice per pairing (null until asked)', async () => {
    const t = await model()
    const prefs = t.model.pushPrefs()
    expect(await prefs.load()).toBeNull()
    await prefs.save(false)
    expect(await prefs.load()).toBe(false)
    t.storage.data.set(VAULT_KEYS.push, 'garbage')
    expect(await prefs.load()).toBeNull()
  })
})
