import { deriveSessionKey, fromHex, pairingUrl, sealPairMessage, type RemoteQueueItem, type RemoteRun, type RemoteTranscriptItem } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { mergeItems, RemoteModel } from './model'
import { MemoryStorage } from './platform'
import { FakeClock, FakeDesktop, NOW, STATUS, Sockets, fixture, pairedVault, presence, settle } from './test-helpers'
import { Vault, VAULT_KEYS } from './vault'

const RUN: RemoteRun = {
  id: 'run-1',
  title: 'Stripe · Senior Backend Engineer',
  agent: 'claude',
  status: 'waiting',
  job: { company: 'Stripe', role: 'Senior Backend Engineer' },
  options: { coverLetter: false, dateStyle: 'inline' },
  createdAt: new Date(NOW - 252_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  files: [],
  costUsd: 0.44,
  live: true
}

const item = (over: Partial<RemoteQueueItem> = {}): RemoteQueueItem => ({
  id: 'item-1',
  jobId: 'url:0123456789abcdef',
  title: 'Stripe · Senior Backend Engineer',
  agent: 'claude',
  status: 'needs-reply',
  runId: 'run-1',
  attempts: 1,
  hasPendingReply: false,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  ...over
})

const text = (i: number): RemoteTranscriptItem => ({ kind: 'assistant', id: `t${i}`, text: `item ${i}` })

async function connected(storage?: MemoryStorage) {
  const clock = new FakeClock()
  const sockets = new Sockets()
  const { vault, storage: s } = storage ? { vault: new Vault(storage), storage } : await pairedVault()
  const model = new RemoteModel({ vault, socket: sockets.factory, clock, appVersion: '0.1.0', deviceName: 'iPhone', random: () => 0.5 })
  await model.init()
  const desktop = new FakeDesktop(clock)
  sockets.last.open()
  sockets.last.receive(presence())
  await settle()
  const hello = sockets.last.envelopes()[0]
  sockets.last.receive(desktop.frame({ kind: 'hello', body: { protocol: { min: 1, max: 1 }, name: 'Mac', appVersion: '0.1.0', workspace: { id: STATUS.desktop.workspaceId, name: 'The den' } } }, { ack: hello.id }))
  sockets.last.receive(desktop.event('status', STATUS))
  await settle()
  /** The last command envelope of a name. */
  const sentCmd = (name: string) => sockets.last.envelopes().filter((e) => e.name === name).at(-1)!
  return { clock, sockets, vault, storage: s, model, desktop, sentCmd }
}

describe('remote model', () => {
  it('shows the paired state from the vault, then the presence, hello workspace, status and queue', async () => {
    const t = await connected()
    const snap = t.model.getSnapshot()
    expect(snap.phase).toBe('paired')
    expect(snap.presence).toMatchObject({ online: true })
    expect(snap.status?.desktop.workspaceName).toBe('The den')
    expect(t.model.workspaceId()).toBe(STATUS.desktop.workspaceId)
    // Hello told the workspace: the queue is asked for.
    const q = t.sentCmd('queue.get')
    expect(q.ws).toBe(STATUS.desktop.workspaceId)
    t.sockets.last.receive(t.desktop.result(q.id!, { items: [item()], concurrency: 2, paused: false }))
    await settle()
    expect(t.model.getSnapshot().queue?.items).toHaveLength(1)
  })

  it('persists the last StatusSummary and shows it at the next start, before any socket', async () => {
    const t = await connected()
    expect(JSON.parse(t.storage.data.get(VAULT_KEYS.status)!).status).toEqual(STATUS)
    t.model.stop()
    const again = new RemoteModel({ vault: new Vault(t.storage), socket: new Sockets().factory, clock: t.clock, appVersion: '0.1.0', deviceName: 'iPhone' })
    await again.init()
    expect(again.getSnapshot().status).toEqual(STATUS)
    again.stop()
  })

  it('pages a transcript with run.get sinceSeq and keeps it in memory only', async () => {
    const t = await connected()
    t.model.openRun('run-1')
    await settle()
    const first = t.sentCmd('run.get')
    expect(first.body).toEqual({ runId: 'run-1' })
    t.sockets.last.receive(t.desktop.result(first.id!, { run: RUN, items: [text(0), text(1), text(2)], nextSeq: 3 }))
    await settle()
    const second = t.sentCmd('run.get')
    expect(second.body).toEqual({ runId: 'run-1', sinceSeq: 3 })
    expect(t.model.getSnapshot().runs['run-1']).toMatchObject({ loading: true, complete: false })
    t.sockets.last.receive(t.desktop.result(second.id!, { run: RUN, items: [text(3), { ...text(4), truncated: true }] }))
    await settle()
    const view = t.model.getSnapshot().runs['run-1']
    expect(view).toMatchObject({ loading: false, complete: true })
    expect(view.items.map((i) => i.id)).toEqual(['t0', 't1', 't2', 't3', 't4'])

    // A change refetches from the last item (it may have been updated in place).
    t.sockets.last.receive(t.desktop.event('run.changed', { ...RUN, status: 'running' }))
    await settle()
    expect(t.sentCmd('run.get').body).toEqual({ runId: 'run-1', sinceSeq: 4 })

    // Nothing of the transcript is in the secure store.
    const stored = [...t.storage.data.keys()]
    expect(stored.every((k) => (Object.values(VAULT_KEYS) as string[]).includes(k))).toBe(true)
    expect([...t.storage.data.values()].join('')).not.toContain('item 3')
  })

  it('holds the reply box while the queue holds a reply or this phone’s reply is unanswered', async () => {
    const t = await connected()
    t.sockets.last.receive(t.desktop.event('queue.changed', { items: [item({ hasPendingReply: true })], concurrency: 2, paused: false }))
    await settle()
    expect(t.model.replyHeld('run-1')).toBe(true)
    t.sockets.last.receive(t.desktop.event('queue.changed', { items: [item()], concurrency: 2, paused: false }))
    await settle()
    expect(t.model.replyHeld('run-1')).toBe(false)
    t.model.reply('run-1', 'Approve R1.')
    await settle()
    expect(t.model.replyHeld('run-1')).toBe(true)
    const reply = t.sentCmd('run.reply')
    t.sockets.last.receive(t.desktop.result(reply.id!, RUN))
    await settle()
    expect(t.model.replyHeld('run-1')).toBe(false)
  })

  it('shows queued and expired commands while the Mac sleeps', async () => {
    const t = await connected()
    t.sockets.last.receive(presence(false))
    t.model.pipelinePause()
    t.model.reply('run-1', 'hi')
    await settle()
    const [reply, pause] = t.model.getSnapshot().commands
    t.sockets.last.receive({ queued: true, ref: pause.id })
    t.sockets.last.receive({ expired: true, ref: reply.id })
    await settle()
    const snap = t.model.getSnapshot()
    expect(snap.presence?.online).toBe(false)
    expect(snap.commands.map((c) => [c.label, c.state])).toEqual([
      ['Reply', 'expired'],
      ['Pause pipeline', 'queued']
    ])
  })

  it('a denied answer wipes the vault and shows Pair again', async () => {
    const t = await connected()
    t.model.refreshQueue()
    await settle()
    const q = t.sentCmd('queue.get')
    t.sockets.last.receive(t.desktop.result(q.id!, null, { ok: false, error: { code: 'denied', message: 'seq 3 is not above the last accepted 9; this device must be paired again.' } }))
    await settle()
    const snap = t.model.getSnapshot()
    expect(snap.phase).toBe('unpaired')
    expect(snap.pairAgain?.reason).toBe('denied')
    expect(t.storage.data.size).toBe(0)
  })

  it('device.revoked wipes the keys', async () => {
    const t = await connected()
    t.sockets.last.receive(t.desktop.event('device.revoked', { reason: 'Revoked' }))
    await settle()
    expect(t.storage.data.size).toBe(0)
    expect(t.model.getSnapshot()).toMatchObject({ phase: 'unpaired', pairAgain: { reason: 'revoked' } })
  })

  it('unpair wipes the keys and closes the socket', async () => {
    const t = await connected()
    await t.model.unpair()
    expect(t.storage.data.size).toBe(0)
    expect(t.sockets.last.closed).not.toBeNull()
    expect(t.model.getSnapshot()).toMatchObject({ phase: 'unpaired', pairAgain: null })
  })

  it('a renamed phone says its new name in the next hello; categories are stored and sent', async () => {
    const t = await connected()
    await t.model.setDeviceName('Work phone')
    await t.model.setNotifications(['needs-reply'])
    await settle()
    expect(t.sentCmd('device.setNotifications').body).toEqual({ categories: ['needs-reply'] })
    expect((await new Vault(t.storage).loadPairing())?.categories).toEqual(['needs-reply'])
    t.sockets.last.serverClose(1006)
    await t.clock.advance(1_500)
    t.sockets.last.open()
    t.sockets.last.receive(presence())
    await settle()
    const hello = t.sockets.last.envelopes().find((e) => e.kind === 'hello')!
    expect(hello.body).toMatchObject({ name: 'Work phone' })
  })

  it('a failed command shows the desktop message', async () => {
    const t = await connected()
    t.model.pipelineStop()
    await settle()
    const stop = t.sentCmd('pipeline.stop')
    t.sockets.last.receive(t.desktop.result(stop.id!, null, { ok: false, error: { code: 'unsupported', message: 'Pipelines and reviews are not available on this Mac yet. Update Huntgry.' } }))
    await settle()
    expect(t.model.getSnapshot().toast?.text).toMatch(/not available on this Mac yet/)
  })
})

describe('mergeItems', () => {
  it('replaces the indexes a page covers and keeps the rest', () => {
    const a = [text(0), text(1), text(2)]
    expect(mergeItems(a, 2, [{ kind: 'assistant', id: 't2', text: 'updated' }, text(3)]).map((i) => (i.kind === 'assistant' ? i.text : ''))).toEqual(['item 0', 'item 1', 'updated', 'item 3'])
    expect(mergeItems([], 0, a)).toEqual(a)
  })
})

describe('pairing from the model', () => {
  it('connects with the new pairing and tells the desktop the notification categories', async () => {
    const clock = new FakeClock()
    const sockets = new Sockets()
    const storage = new MemoryStorage()
    const model = new RemoteModel({ vault: new Vault(storage), socket: sockets.factory, clock, appVersion: '0.1.0', deviceName: 'iPhone' })
    await model.init()
    const secret = fromHex(fixture.pairingSecret)
    const done = model.pair(pairingUrl({ v: 1, relay: 'https://relay.example.com', room: 'room-1', pairing: 'p-1', desktopPublicKey: fromHex(fixture.desktopPublicKey), secret, exp: NOW / 1000 + 120 }))
    await settle()
    sockets.last.open()
    sockets.last.receive(presence())
    await settle()
    // The desktop seals pair.ok with its side of the session key.
    const devicePub = (await new Vault(storage).loadIdentity())!.publicKey
    const key = deriveSessionKey(devicePub, fromHex(fixture.desktopSecretKey))
    const ok = { deviceId: 'd-1', relayToken: 'ef'.repeat(32), desktopName: 'Mac', protocol: { min: 1, max: 1 }, sid: 'sid-2' }
    sockets.last.receive({ to: 'p-1', ref: 'r-1', ...sealPairMessage({ pair: 'ok', ok }, key), ttl: 120 })
    await done
    expect(model.getSnapshot().phase).toBe('paired')
    const session = sockets.last
    expect(session.url).toBe('wss://relay.example.com/ws')
    session.open()
    expect(session.json(0)).toEqual({ auth: { room: 'room-1', device: 'd-1', token: 'ef'.repeat(32) } })
    session.receive(presence())
    await settle()
    const envs = session.envelopes(key)
    expect(envs.map((e) => e.kind)).toEqual(['hello', 'cmd'])
    expect(envs[1]).toMatchObject({ name: 'device.setNotifications', seq: 2, sid: 'sid-2', body: { categories: ['needs-reply', 'usage-limit', 'pipeline-finished', 'needs-review', 'failed'] } })
    model.stop()
  })
})

describe('first launch', () => {
  it('without a pairing the app is on the Pair screen', async () => {
    const model = new RemoteModel({ vault: new Vault(new MemoryStorage()), socket: new Sockets().factory, clock: new FakeClock(), appVersion: '0.1.0', deviceName: 'iPhone' })
    await model.init()
    expect(model.getSnapshot().phase).toBe('unpaired')
  })
})
