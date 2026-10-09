import { deriveSessionKey, fromHex, toHex, type Envelope } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { commands, NoWorkspaceError } from './commands'
import { MemoryStorage } from './platform'
import { RelayClient, type RelayClientEvents } from './relay'
import { FakeClock, FakeDesktop, PAIRING, SESSION_KEY, STATUS, Sockets, fixture, pairedVault, presence, settle } from './test-helpers'
import { Vault, VAULT_KEYS } from './vault'

async function setup(opts: { storage?: MemoryStorage; workspace?: string | null; events?: Partial<RelayClientEvents>; random?: () => number } = {}) {
  const clock = new FakeClock()
  const sockets = new Sockets()
  const { storage, vault } = opts.storage ? { storage: opts.storage, vault: new Vault(opts.storage) } : await pairedVault()
  if (opts.storage) await vault.loadPairing()
  const received: Envelope[] = []
  const fatal: string[] = []
  const deliveries: [string, string][] = []
  let workspace = opts.workspace === undefined ? STATUS.desktop.workspaceId : opts.workspace
  const client = new RelayClient({
    pairing: PAIRING,
    vault,
    socket: sockets.factory,
    clock,
    random: opts.random ?? (() => 0.5),
    appVersion: '0.1.0',
    workspaceId: () => workspace,
    events: {
      onEnvelope: (env) => {
        received.push(env)
      },
      onFatal: (reason) => {
        fatal.push(reason)
      },
      onDelivery: (id, state) => {
        deliveries.push([id, state])
      },
      ...opts.events
    }
  })
  const desktop = new FakeDesktop(clock)
  /** Opens the socket and authenticates it (relay presence). */
  const online = async (desktopOnline = true) => {
    sockets.last.open()
    sockets.last.receive(presence(desktopOnline))
    await settle()
  }
  return { clock, sockets, storage, vault, client, desktop, received, fatal, deliveries, online, setWorkspace: (w: string | null) => (workspace = w) }
}

describe('relay client: connection and first-frame auth', () => {
  it('connects to the bare /ws URL and authenticates with the first frame only', async () => {
    const t = await setup()
    t.client.start()
    const socket = t.sockets.last
    expect(socket.url).toBe('wss://relay.example.com/ws')
    expect(socket.url).not.toContain('?')
    expect(socket.url).not.toContain(PAIRING.relayToken)
    socket.open()
    await settle()
    expect(socket.sent).toHaveLength(1)
    expect(socket.json(0)).toEqual({ auth: { room: 'room-1', device: 'device-1', token: PAIRING.relayToken } })
    // Nothing else until the relay has accepted the auth frame.
    t.client.send(commands.status())
    await settle()
    expect(socket.sent).toHaveLength(1)
  })

  it('sends hello first after presence, boxed with the fixture session key', async () => {
    const t = await setup()
    // The pinned fixture: the phone's and the desktop's derivations agree.
    expect(toHex(deriveSessionKey(fromHex(fixture.desktopPublicKey), fromHex(fixture.phoneSecretKey)))).toBe(fixture.sessionKey)
    t.client.start()
    await t.online()
    const [hello] = t.sockets.last.envelopes()
    const [frame] = t.sockets.last.frames()
    expect(frame.to).toBe('desktop')
    expect(frame.ref).toBe(hello.id)
    expect(frame.ttl).toBe(60)
    expect(hello).toMatchObject({ v: 1, sid: 'sid-1', from: 'phone', seq: 1, kind: 'hello', body: { protocol: { min: 1, max: 1 }, name: "Ashish's iPhone", appVersion: '0.1.0' } })
    expect(t.client.connection).toBe('online')
  })
})

describe('relay client: commands, seq and ws', () => {
  it('persists every seq before the frame carrying it is sent, one counter for every kind', async () => {
    const t = await setup()
    const atSend: [number, number][] = []
    t.client.start()
    t.sockets.last.onSend = (text) => {
      const f = JSON.parse(text) as Record<string, unknown>
      if (!('ct' in f)) return
      const env = t.sockets.last.envelopes().length // index of the frame being sent
      const stored = JSON.parse((t.storage.data.get(VAULT_KEYS.seq) ?? '{}') as string).seq as number
      atSend.push([env, stored])
    }
    await t.online()
    t.client.send(commands.status())
    t.client.send(commands.queue())
    t.client.send(commands.setQueuePaused(true))
    await settle()
    const seqs = t.sockets.last.envelopes().map((e) => e.seq)
    expect(seqs).toEqual([1, 2, 3, 4])
    // At the moment each frame left, the secure store already held its seq.
    expect(atSend.map(([, stored]) => stored)).toEqual([1, 2, 3, 4])

    // A restart continues from the stored counter, never below it.
    const t2 = await setup({ storage: t.storage })
    t2.client.start()
    await t2.online()
    expect(t2.sockets.last.envelopes()[0].seq).toBe(5)
  })

  it('puts ws on workspace commands only, ttl from ttlFor, a uuid id equal to the ref', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    const statusId = t.client.send(commands.status())
    const replyId = t.client.send(commands.reply('run-1', 'Approve R1.'))
    const notifId = t.client.send(commands.setNotifications(['failed', 'needs-reply']))
    await settle()
    const [, status, reply, notif] = t.sockets.last.envelopes()
    expect(status).toMatchObject({ kind: 'cmd', name: 'status.get', id: statusId, ttl: 86_400, body: null })
    expect(status.ws).toBeUndefined()
    expect(reply).toMatchObject({ name: 'run.reply', id: replyId, ws: STATUS.desktop.workspaceId, ttl: 7200, body: { runId: 'run-1', text: 'Approve R1.' } })
    expect(notif).toMatchObject({ name: 'device.setNotifications', id: notifId, body: { categories: ['needs-reply', 'failed'] } })
    expect(notif.ws).toBeUndefined()
    expect(statusId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(t.sockets.last.frames().map((f) => f.ref)).toEqual(t.sockets.last.envelopes().map((e) => e.id))
  })

  it('refuses a workspace command before the workspace is known', async () => {
    const t = await setup({ workspace: null })
    t.client.start()
    await t.online()
    expect(() => t.client.send(commands.queue())).toThrow(NoWorkspaceError)
    expect(() => t.client.send(commands.status())).not.toThrow()
  })
})

describe('relay client: incoming frames, acks and dedupe', () => {
  it('hands a result over, stores the desktop seq, then acks it by the frame ref', async () => {
    const t = await setup()
    const order: string[] = []
    t.client.start()
    await t.online()
    const id = t.client.send(commands.queue())
    await settle()
    const frame = t.desktop.result(id, { items: [], concurrency: 2, paused: false })
    const origSet = t.storage.setItem.bind(t.storage)
    t.storage.setItem = async (k, v) => {
      if (k === VAULT_KEYS.lastSeq) order.push('stored')
      return origSet(k, v)
    }
    t.sockets.last.onSend = (text) => {
      if (JSON.parse(text).ack === frame.ref) order.push('acked')
    }
    t.sockets.last.receive(frame)
    await settle()
    expect(t.received.map((e) => e.re)).toEqual([id])
    expect(t.vault.desktopLastSeq).toBe(101)
    expect(t.sockets.last.acks()).toContain(frame.ref)
    expect(order).toEqual(['stored', 'acked'])
    expect(t.deliveries).toContainEqual([id, 'done'])
  })

  it('drops duplicates by id and by re, acking each copy', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    const event = t.desktop.event('status', STATUS)
    t.sockets.last.receive(event)
    t.sockets.last.receive(event)
    const id = t.client.send(commands.status())
    await settle()
    t.sockets.last.receive(t.desktop.result(id, STATUS))
    t.sockets.last.receive(t.desktop.result(id, STATUS)) // a second answer to the same command (new id, same re)
    await settle()
    expect(t.received.filter((e) => e.kind === 'event')).toHaveLength(1)
    expect(t.received.filter((e) => e.kind === 'result')).toHaveLength(1)
    expect(t.sockets.last.acks().filter((a) => a === event.ref)).toHaveLength(2)
  })

  it('accepts desktop seq gaps and drops a frame at or below lastSeq', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    t.sockets.last.receive(t.desktop.event('status', STATUS, { seq: 5 }))
    t.sockets.last.receive(t.desktop.event('status', STATUS, { seq: 9 }))
    const old = t.desktop.event('status', STATUS, { seq: 7 })
    t.sockets.last.receive(old)
    await settle()
    expect(t.received.map((e) => e.seq)).toEqual([5, 9])
    expect(t.vault.desktopLastSeq).toBe(9)
    expect(t.sockets.last.acks()).toContain(old.ref)
  })

  it('leaves a frame no key opens unacked, and acks a stale one', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    const foreign = new FakeDesktop(t.clock, new Uint8Array(32).fill(7)).event('status', STATUS)
    t.sockets.last.receive(foreign)
    const tampered = t.desktop.event('status', STATUS)
    tampered.ct = tampered.ct.slice(0, -4) + (tampered.ct.endsWith('AAA=') ? 'BBB=' : 'AAA=')
    t.sockets.last.receive(tampered)
    const stale = t.desktop.frame({ kind: 'event', name: 'status', body: STATUS, ts: new Date(t.clock.now() - 120_000).toISOString(), ttl: 60 })
    t.sockets.last.receive(stale)
    await settle()
    expect(t.received).toHaveLength(0)
    expect(t.sockets.last.acks()).not.toContain(foreign.ref)
    expect(t.sockets.last.acks()).not.toContain(tampered.ref)
    expect(t.sockets.last.acks()).toContain(stale.ref)
  })

  it('throttles acks under the relay budget and piggybacks one on the next command', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    for (let i = 0; i < 60; i++) t.sockets.last.receive(t.desktop.event('status', STATUS))
    await settle(80)
    // auth + hello + acks stay within the ack share of the per-minute budget.
    expect(t.sockets.last.sent.length).toBeLessThanOrEqual(40)
    expect(t.sockets.last.acks().length).toBe(38)
    // A command still has room and carries one pending ack.
    t.client.send(commands.status())
    await settle()
    const last = t.sockets.last.frames().at(-1)!
    expect(typeof last.ack).toBe('string')
    // The rest goes after the window rolls over.
    await t.clock.advance(61_000)
    await settle(80)
    expect(new Set(t.sockets.last.acks()).size).toBe(60)
  })

  it('reports queued, expired and too-large notices for a command', async () => {
    const t = await setup()
    t.client.start()
    await t.online(false)
    const a = t.client.send(commands.setQueuePaused(true))
    const b = t.client.send(commands.reply('run-1', 'hi'))
    const c = t.client.send(commands.status())
    await settle()
    t.sockets.last.receive({ queued: true, ref: a })
    t.sockets.last.receive({ expired: true, ref: b })
    t.sockets.last.receive({ tooLarge: true, ref: c, bytes: 70_000 })
    await settle()
    expect(t.deliveries).toEqual(expect.arrayContaining([[a, 'queued'], [b, 'expired'], [c, 'too-large']]))
    expect(t.client.pending().map((p) => p.id)).toEqual([a])
  })
})

describe('relay client: reconnect', () => {
  it('backs off, re-authenticates and retransmits an unanswered command byte for byte before anything new', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    const id = t.client.send(commands.setQueuePaused(true))
    await settle()
    const original = t.sockets.last.frames().find((f) => f.ref === id)!
    t.sockets.last.serverClose(1006)
    expect(t.client.connection).toBe('retrying')
    await t.clock.advance(999)
    expect(t.sockets.all).toHaveLength(1)
    await t.clock.advance(2)
    expect(t.sockets.all).toHaveLength(2)
    await t.online()
    const second = t.sockets.last
    expect(second.json(0)).toHaveProperty('auth')
    const [resent, hello] = second.frames()
    expect(resent.ref).toBe(id)
    expect(resent.ct).toBe(original.ct)
    expect(resent.nonce).toBe(original.nonce)
    const helloEnv = second.envelopes()[1]
    expect(helloEnv.kind).toBe('hello')
    expect(helloEnv.seq).toBeGreaterThan(second.envelopes()[0].seq)
    expect(hello.ref).toBe(helloEnv.id)
  })

  it('grows the backoff and waits at least 30 s after a rate-limit close', async () => {
    const t = await setup()
    t.client.start()
    t.sockets.last.serverClose(1006) // attempt 0: 1 s
    await t.clock.advance(1_000)
    t.sockets.last.serverClose(1006) // attempt 1: 2 s
    await t.clock.advance(1_999)
    expect(t.sockets.all).toHaveLength(2)
    await t.clock.advance(1)
    expect(t.sockets.all).toHaveLength(3)
    t.sockets.last.serverClose(1008)
    await t.clock.advance(29_000)
    expect(t.sockets.all).toHaveLength(3)
    await t.clock.advance(1_001)
    expect(t.sockets.all).toHaveLength(4)
  })

  it('does not fight a replacing socket (4000) until woken', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    t.sockets.last.serverClose(4000)
    expect(t.client.connection).toBe('replaced')
    await t.clock.advance(120_000)
    expect(t.sockets.all).toHaveLength(1)
    t.client.wake()
    expect(t.sockets.all).toHaveLength(2)
  })

  it('replaces a socket that answers nothing after a ping', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    await t.clock.advance(120_000) // ping
    expect(t.sockets.last.envelopes().at(-1)!.kind).toBe('ping')
    await t.clock.advance(20_000) // no answer
    await t.clock.advance(2_000)
    expect(t.sockets.all).toHaveLength(2)
  })
})

describe('relay client: the pairing is over', () => {
  for (const [code, reason] of [
    [4001, 'revoked'],
    [4002, 'unauthorized'],
    [4004, 'room-deleted']
  ] as const) {
    it(`close ${code} is fatal (${reason})`, async () => {
      const t = await setup()
      t.client.start()
      await t.online()
      t.sockets.last.serverClose(code)
      await settle()
      expect(t.fatal).toEqual([reason])
      await t.clock.advance(120_000)
      expect(t.sockets.all).toHaveLength(1)
    })
  }

  it('a denied answer to a command or to hello means pair again', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    const hello = t.sockets.last.envelopes()[0]
    t.sockets.last.receive(t.desktop.result(hello.id!, null, { ok: false, error: { code: 'denied', message: 'This phone must be paired again.' } }))
    await settle()
    expect(t.fatal).toEqual(['denied'])
  })

  it('a denied review answer is not a re-pair (#42 revision rule)', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    const id = t.client.send({ name: 'review.list' })
    await settle()
    t.sockets.last.receive(t.desktop.result(id, null, { ok: false, error: { code: 'denied', message: 'Open this review first.' } }))
    await settle()
    expect(t.fatal).toEqual([])
    expect(t.received).toHaveLength(1)
  })

  it('a denied answer to a command sent before a restart is not a re-pair; the next hello decides', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    // A review.approve queued at the relay, then the app was killed: this client never saw it.
    t.sockets.last.receive(t.desktop.result('0e2f6a55-0c4b-4b5e-9a62-1f7d2c3b4a59', null, { ok: false, error: { code: 'denied', message: 'Open this result again before you decide.' } }))
    await settle()
    expect(t.fatal).toEqual([])
    expect(t.sockets.last.acks()).toHaveLength(1)
  })

  it('device.revoked is acked and fatal', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    const revoked = t.desktop.event('device.revoked', { reason: 'Revoked on the Mac' })
    t.sockets.last.receive(revoked)
    await settle()
    expect(t.fatal).toEqual(['revoked'])
    expect(t.sockets.last.acks()).toContain(revoked.ref)
  })

  it('keeps the session key out of everything it sends', async () => {
    const t = await setup()
    t.client.start()
    await t.online()
    t.client.send(commands.status())
    await settle()
    const all = t.sockets.last.sent.join('\n')
    expect(all).not.toContain(PAIRING.sessionKey)
    expect(all).not.toContain(toHex(SESSION_KEY))
  })
})
