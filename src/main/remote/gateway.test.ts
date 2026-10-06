import { chmodSync, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { QueueState } from '@shared/queue-types'
import type { RunSummary } from '@shared/runner-types'
import { buildTranscript } from '@shared/transcript'
import { COMMAND_TTL_SECONDS, LIMITS, type Envelope, type FileChunk, type RemoteCommandName, type RemoteQueueState, type RunPage, type StatusSummary } from '@shared/remote'
import { RunManager, type RunContext } from '../cli/runner'
import { readEvents, readRun } from '../cli/runs'
import { queueFile, TailorQueue, type QueueDeps } from '../queue/queue'
import { auditFile } from './audit'
import { DeviceStore } from './devices'
import { DurabilityError, Gateway, MAX_REMOTE_FILE_BYTES, SimulatedCrash, type GatewayServices } from './gateway'
import { command, fakeCipher, fakePhone, job, type FakePhone } from './test-helpers'
import { workspaceIdentity, type WorkspaceIdentity } from './workspace'

const FAKE = join(__dirname, '../cli/fixtures/fake-claude.mjs')

let ws: string
let dir: string
let identity: WorkspaceIdentity
let devices: DeviceStore
let phone: FakePhone
let manager: RunManager
let queue: TailorQueue
let jobs: Map<string, Job>
let now: number
let gateway: Gateway
let services: GatewayServices
let crashAt: GatewayServices['crashAt']
let addedUrls: string[]
/** Overrides the app's open workspace (the queue's view); `null` = the test workspace. */
let openWs: string | null
/** The workspace path each runs service call was given. */
let runsCalls: string[]
let onFindJob: (() => Promise<void>) | undefined

const ctx = (): RunContext => ({
  workspace: ws,
  skillDir: '/skills/resume-tailor',
  sandbox: { workspace: ws, skillDir: '/skills/resume-tailor', venvDir: '/venv', texRoot: null },
  command: process.execPath,
  commandPrefixArgs: [FAKE],
  env: { ...process.env },
  systemPrompt: 'test'
})

function queueDeps(): QueueDeps {
  return {
    // The workspace open in the app; a test may switch it (`openWs`) under a command.
    workspace: async () => openWs ?? ws,
    findJob: async (_ws, id) => {
      await onFindJob?.()
      return jobs.get(id) ?? null
    },
    fetchDetails: async (_ws, id) => jobs.get(id)!,
    markTailored: async () => undefined,
    start: (params) => manager.start(params, ctx()),
    stopRun: (id, workspace) => manager.stopAny(workspace, id),
    reply: (id, text) => manager.reply(id, text, async () => ctx()),
    onChange: () => undefined,
    spawnGapMs: 0
  }
}

async function currentRun(id: string): Promise<RunSummary> {
  return manager.liveRun(id) ? { ...manager.liveRun(id)!, live: true } : readRun(ws, id)
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-gw-ws-'))
  dir = await mkdtemp(join(tmpdir(), 'huntgry-gw-user-'))
  identity = await workspaceIdentity(ws)
  devices = new DeviceStore(dir, fakeCipher())
  await devices.load()
  phone = fakePhone((await devices.keyPair())!)
  await devices.add(phone.record)
  jobs = new Map()
  addedUrls = []
  now = Date.parse('2026-09-30T12:00:00.000Z')
  manager = new RunManager({ onEvent: () => undefined, onRun: (r) => queue.onRun(r) })
  queue = new TailorQueue(queueDeps())
  crashAt = undefined
  openWs = null
  runsCalls = []
  onFindJob = undefined
  services = {
    desktopName: 'Test Mac',
    appVersion: '0.1.0-test',
    workspace: async () => identity,
    agents: async () => [{ id: 'claude', ready: true }, { id: 'codex', ready: false }, { id: 'antigravity', ready: false }],
    defaultAgent: async () => 'claude',
    // The same mapping as queueForRemote in queue/ipc.ts: the checked workspace goes to the queue.
    queue: {
      state: (w) => queue.sync(w),
      setPaused: (w, p) => queue.setPaused(p, w),
      cancel: (w, id) => queue.cancel(id, w),
      retry: (w, id) => queue.retry(id, w),
      enqueue: (w, input) => queue.enqueue(input, w),
      reply: (w, id, text) => queue.reply(id, text, w)
    },
    runs: {
      list: async (w) => {
        runsCalls.push(w)
        return []
      },
      get: async (w, id) => {
        runsCalls.push(w)
        await manager.flush(id)
        const run = await currentRun(id)
        return { run, items: buildTranscript(await readEvents(w, id), run.agent) }
      },
      reply: (w, id, text) => {
        runsCalls.push(w)
        return manager.reply(id, text, async () => ctx())
      },
      stop: async (w, id) => {
        runsCalls.push(w)
        manager.stop(id)
        return currentRun(id)
      },
      finish: async (w, id) => {
        runsCalls.push(w)
        manager.finish(id)
        return currentRun(id)
      }
    },
    jobs: {
      list: async () => [...jobs.values()],
      addUrl: async (_ws, url) => {
        addedUrls.push(url)
        return job('url:added', { url })
      }
    },
    files: { resolve: async (workspace, applicationId, file) => join(workspace, applicationId, file) },
    transcripts: () => true,
    resolveHost: async (host) => (host === 'jobs.example.com' ? ['93.184.216.34'] : host === 'evil.example.com' ? ['127.0.0.1'] : ['10.0.0.5']),
    now: () => now,
    crashAt: (step, name) => crashAt?.(step, name)
  }
  gateway = new Gateway(services, devices)
})

afterEach(async () => {
  await queue.shutdown()
  manager.stopAll()
  await manager.whenIdle()
  await devices.flush()
  await rm(ws, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

/** `wsId: null` sends the command without `Envelope.ws`. */
const send = (name: RemoteCommandName, args?: unknown, over: Partial<Envelope> = {}, wsId: string | null = identity.id) =>
  gateway.handle(devices.get(phone.id)!, command(phone, name, args, wsId ?? undefined, { ts: new Date(now).toISOString(), ...over }))

const auditLines = async () => (await readFile(auditFile(ws), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

/** Waits until `pred` holds on the queue state. */
async function until(pred: (s: QueueState) => boolean, ms = 5000): Promise<QueueState> {
  const t0 = Date.now()
  for (;;) {
    const s = queue.state()
    if (pred(s)) return s
    if (Date.now() - t0 > ms) throw new Error(`timeout; statuses ${s.items.map((i) => i.status).join(',')}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('Gateway: reads and status', () => {
  it('answers status.get without ws, with the workspace name and random id, never the path', async () => {
    const reply = await send('status.get', undefined, {}, null)
    expect(reply.result.ok).toBe(true)
    const status = reply.result.body as StatusSummary
    expect(status.desktop).toEqual({ name: 'Test Mac', appVersion: '0.1.0-test', workspaceName: identity.name, workspaceId: identity.id })
    expect(JSON.stringify(status)).not.toContain(ws)
    expect(status.agents).toEqual([{ id: 'claude', ready: true }, { id: 'codex', ready: false }, { id: 'antigravity', ready: false }])
    expect(reply.ack).toBe(phone.seq === 1 ? reply.result.re : reply.result.re)
    // The read is audited (device, name, outcome, time) without a write-ahead entry.
    const lines = await auditLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ deviceId: phone.id, name: 'status.get', ok: true, read: true, seq: 1 })
    expect(lines[0].started).toBeUndefined()
  })

  it('checks Envelope.ws on every workspace-scoped command, reads included', async () => {
    const other = 'f'.repeat(32)
    for (const [name, args] of [['queue.get', undefined], ['runs.list', {}], ['jobs.list', {}], ['run.get', { runId: '20260930-010203-a1b2c3' }], ['queue.setPaused', { paused: true }]] as const) {
      const missing = await send(name, args, {}, null)
      expect(missing.result.ok, `${name} without ws`).toBe(false)
      expect(missing.result.error?.code).toBe('invalid')
      const mismatch = await send(name, args, {}, other)
      expect(mismatch.result.ok, `${name} other ws`).toBe(false)
      expect(mismatch.result.error?.code).toBe('invalid')
      expect(mismatch.result.error?.message).toMatch(/workspace changed/i)
    }
    expect((await send('device.setNotifications', { categories: ['failed'] }, {}, null)).result.ok).toBe(true)
    expect(devices.get(phone.id)!.categories).toEqual(['failed'])
    // Nothing executed on the mismatches: the queue is still unpaused... it starts paused after load; a mutating setPaused(true) would have left no trace either way, so check the audit.
    const lines = await auditLines()
    expect(lines.filter((l) => l.started).map((l) => l.name)).toEqual(['device.setNotifications'])
    expect(lines.every((l) => l.ok === false || l.name === 'device.setNotifications')).toBe(true)
  })

  it('answers unsupported for an unknown name and for pipeline / review commands this desktop has not got', async () => {
    const unknown = await send('status.get', undefined, { name: 'apply.start' as RemoteCommandName })
    expect(unknown.result.error?.code).toBe('unsupported')
    const pipeline = await send('pipeline.pause')
    expect(pipeline.result.error?.code).toBe('unsupported')
    const review = await send('review.list')
    expect(review.result.error?.code).toBe('unsupported')
  })

  it('rate-limits reads at 30 per minute', async () => {
    for (let i = 0; i < 30; i++) expect((await send('queue.get')).result.ok).toBe(true)
    const limited = await send('queue.get')
    expect(limited.result.error?.code).toBe('rate-limited')
    now += 61_000
    expect((await send('queue.get')).result.ok).toBe(true)
  })
})

describe('Gateway: replay and expiry', () => {
  it('rejects a rewound seq with denied, marks the device needs-repair and executes nothing afterwards', async () => {
    expect((await send('queue.setPaused', { paused: true })).result.ok).toBe(true)
    expect((await send('queue.setPaused', { paused: false })).result.ok).toBe(true)
    const rewound = await gateway.handle(devices.get(phone.id)!, command(phone, 'queue.setPaused', { paused: true }, identity.id, { seq: 1, ts: new Date(now).toISOString() }))
    expect(rewound.result.error?.code).toBe('denied')
    expect(devices.get(phone.id)!.needsRepair).toBe(true)
    expect(queue.state().paused).toBe(false)
    const after = await send('queue.setPaused', { paused: true })
    expect(after.result.error?.code).toBe('denied')
    expect(queue.state().paused).toBe(false)
    const lines = await auditLines()
    expect(lines.filter((l) => l.started)).toHaveLength(2)
  })

  it('rejects a frame older than its ttl and a costly command older than COMMAND_TTL_SECONDS.costly', async () => {
    const old = await send('queue.get', undefined, { ts: new Date(now - 25 * 3600 * 1000).toISOString(), ttl: 24 * 3600 })
    expect(old.result.error?.code).toBe('expired')
    // The relay let a 7-day ttl through; the desktop still refuses a 3-hour-old enqueue.
    jobs.set('url:a', job('url:a'))
    const stale = await send('queue.enqueue', { jobIds: ['url:a'], options: { coverLetter: false, dateStyle: 'right' } }, { ts: new Date(now - 3 * 3600 * 1000).toISOString(), ttl: 7 * 24 * 3600 })
    expect(stale.result.error?.code).toBe('expired')
    expect(COMMAND_TTL_SECONDS.costly).toBe(7200)
    expect(queue.state().items).toHaveLength(0)
  })

  it('derives lastSeq from the audit log on start: a fresh checkpoint cannot replay', async () => {
    expect((await send('queue.setPaused', { paused: true })).result.ok).toBe(true)
    expect((await send('queue.get')).result.ok).toBe(true)
    // "Restart" with a checkpoint that lost lastSeq (0): the log says 2.
    const fresh = new DeviceStore(await mkdtemp(join(tmpdir(), 'huntgry-gw-fresh-')), fakeCipher())
    await fresh.load()
    await fresh.add({ ...phone.record, lastSeq: 0 })
    const g2 = new Gateway(services, fresh)
    const replay = await g2.handle(fresh.get(phone.id)!, command(phone, 'queue.setPaused', { paused: false }, identity.id, { seq: 2, ts: new Date(now).toISOString() }))
    expect(replay.result.error?.code).toBe('denied')
    expect(fresh.get(phone.id)!.lastSeq).toBe(2)
  })
})

describe('Gateway: commit order and idempotency', () => {
  const pause = () => ({ paused: true })
  // The queue opens paused after a load; these tests pause it remotely, so start unpaused.
  beforeEach(() => queue.setPaused(false))

  it('writes started before executing and the outcome after, then answers with ack = command id', async () => {
    const env = command(phone, 'queue.setPaused', pause(), identity.id, { ts: new Date(now).toISOString() })
    const reply = await gateway.handle(devices.get(phone.id)!, env)
    expect(reply.ack).toBe(env.id)
    expect(reply.result).toMatchObject({ kind: 'result', re: env.id, ok: true })
    expect((reply.result.body as RemoteQueueState).paused).toBe(true)
    const lines = await auditLines()
    expect(lines.map((l) => [l.id, l.started ?? null, l.ok ?? null])).toEqual([
      [env.id, true, null],
      [env.id, null, true]
    ])
    expect(lines[1].result).toEqual(reply.result.body)
  })

  it('redelivery of a finished id answers the stored result without executing again', async () => {
    const env = command(phone, 'queue.setPaused', pause(), identity.id, { ts: new Date(now).toISOString() })
    const first = await gateway.handle(devices.get(phone.id)!, env)
    await queue.setPaused(false) // the desktop user resumed meanwhile
    const again = await gateway.handle(devices.get(phone.id)!, env)
    expect(again.result.body).toEqual(first.result.body)
    expect(again.ack).toBe(env.id)
    expect(queue.state().paused).toBe(false) // not executed a second time
    expect((await auditLines()).filter((l) => l.id === env.id)).toHaveLength(2)
  })

  it('redelivery of a read answers it again without tripping the replay check or marking the phone for re-pair', async () => {
    const env = command(phone, 'queue.get', undefined, identity.id, { ts: new Date(now).toISOString() })
    const first = await gateway.handle(devices.get(phone.id)!, env)
    expect(first.result.ok).toBe(true)
    // The result frame (carrying the ack) was lost to a disconnect, so the relay delivers the same frame again.
    const again = await gateway.handle(devices.get(phone.id)!, env)
    expect(again.result).toMatchObject({ re: env.id, ok: true })
    expect(devices.get(phone.id)!.needsRepair).toBeFalsy()
    expect(devices.get(phone.id)!.lastSeq).toBe(env.seq)
    // The next command still runs.
    const next = await gateway.handle(devices.get(phone.id)!, command(phone, 'queue.get', undefined, identity.id, { ts: new Date(now).toISOString() }))
    expect(next.result.ok).toBe(true)
  })

  it('a reused read id cannot carry a mutating command past the replay check', async () => {
    const read = command(phone, 'queue.get', undefined, identity.id, { ts: new Date(now).toISOString() })
    await gateway.handle(devices.get(phone.id)!, read)
    const forged = command(phone, 'queue.setPaused', pause(), identity.id, { ts: new Date(now).toISOString(), id: read.id, seq: read.seq })
    const reply = await gateway.handle(devices.get(phone.id)!, forged)
    expect(reply.result.ok).toBe(false)
    expect(queue.state().paused).toBe(false)
  })

  it('a crash before the write-ahead entry leaves nothing; redelivery executes once', async () => {
    crashAt = (step) => {
      if (step === 'before-start') throw new SimulatedCrash(step)
    }
    const env = command(phone, 'queue.setPaused', pause(), identity.id, { ts: new Date(now).toISOString() })
    await expect(gateway.handle(devices.get(phone.id)!, env)).rejects.toBeInstanceOf(SimulatedCrash)
    expect(queue.state().paused).toBe(false)
    expect(await auditLines()).toHaveLength(0)
    // Nothing was checkpointed either: the seq is still free for the relay's redelivery.
    expect(JSON.parse(await readFile(join(dir, 'devices.json'), 'utf8')).devices[0].lastSeq).toBe(0)
    crashAt = undefined
    // "Restart": a new gateway over the same stores (the device store reloads from disk).
    const restarted = new DeviceStore(dir, fakeCipher())
    await restarted.load()
    const g2 = new Gateway(services, restarted)
    const redelivered = await g2.handle(restarted.get(phone.id)!, env)
    expect(redelivered.result.ok).toBe(true)
    expect(queue.state().paused).toBe(true)
    const lines = await auditLines()
    expect(lines.filter((l) => l.id === env.id && l.started)).toHaveLength(1)
    expect(lines.filter((l) => l.id === env.id && l.ok === true)).toHaveLength(1)
  })

  it('a crash between the write-ahead entry and the outcome answers interrupted on redelivery and never re-executes', async () => {
    crashAt = (step) => {
      if (step === 'after-start') throw new SimulatedCrash(step)
    }
    const env = command(phone, 'queue.setPaused', pause(), identity.id, { ts: new Date(now).toISOString() })
    await expect(gateway.handle(devices.get(phone.id)!, env)).rejects.toBeInstanceOf(SimulatedCrash)
    expect(queue.state().paused).toBe(false)
    crashAt = undefined
    const restarted = new Gateway(services, devices) // a new gateway reloads the log
    const redelivered = await restarted.handle(devices.get(phone.id)!, env)
    expect(redelivered.result.ok).toBe(false)
    expect(redelivered.result.error?.message).toMatch(/interrupted/i)
    expect(redelivered.ack).toBe(env.id)
    expect(queue.state().paused).toBe(false)
    expect((await auditLines()).filter((l) => l.id === env.id)).toHaveLength(1)
  })

  it('a crash after execution but before the outcome: redelivery is interrupted, the command ran exactly once', async () => {
    crashAt = (step) => {
      if (step === 'after-execute') throw new SimulatedCrash(step)
    }
    const env = command(phone, 'queue.setPaused', pause(), identity.id, { ts: new Date(now).toISOString() })
    await expect(gateway.handle(devices.get(phone.id)!, env)).rejects.toBeInstanceOf(SimulatedCrash)
    expect(queue.state().paused).toBe(true)
    crashAt = undefined
    await queue.setPaused(false)
    const redelivered = await new Gateway(services, devices).handle(devices.get(phone.id)!, env)
    expect(redelivered.result.error?.message).toMatch(/interrupted/i)
    expect(queue.state().paused).toBe(false) // not run twice
  })

  it('a crash after the outcome but before the result frame: redelivery resends the stored result', async () => {
    crashAt = (step) => {
      if (step === 'after-finish') throw new SimulatedCrash(step)
    }
    const env = command(phone, 'queue.setPaused', pause(), identity.id, { ts: new Date(now).toISOString() })
    await expect(gateway.handle(devices.get(phone.id)!, env)).rejects.toBeInstanceOf(SimulatedCrash)
    crashAt = undefined
    await queue.setPaused(false)
    const redelivered = await new Gateway(services, devices).handle(devices.get(phone.id)!, env)
    expect(redelivered.result.ok).toBe(true)
    expect((redelivered.result.body as RemoteQueueState).paused).toBe(true)
    expect(queue.state().paused).toBe(false)
  })

  it('a service failure is recorded with ok: false and a generic message; the original stays on the Mac', async () => {
    const reply = await send('queue.cancel', { itemId: 'q-20260930-010203-ffffff' })
    expect(reply.result.ok).toBe(false)
    expect(reply.result.error).toEqual({ code: 'failed', message: expect.stringMatching(/failed on your Mac/) })
    const lines = await auditLines()
    expect(lines[1]).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(JSON.stringify(lines)).not.toContain(ws)
  })
})

describe('Gateway: enqueue and reply through the real queue', () => {
  it('queue.enqueue goes through requireEnqueueInput and the TailorQueue; run.reply reaches the sandboxed run', async () => {
    jobs.set('url:a', job('url:a'))
    const enq = await send('queue.enqueue', { jobIds: ['url:a', 'url:gone'], options: { coverLetter: false, dateStyle: 'right', notes: 'from the phone' }, concurrency: 1 })
    expect(enq.result.ok).toBe(true)
    const body = enq.result.body as { added: number; skipped: unknown[]; queue: RemoteQueueState }
    expect(body.added).toBe(1)
    expect(body.skipped).toHaveLength(1)
    expect(JSON.stringify(body)).not.toContain('from the phone') // notes never echo back
    const waiting = await until((s) => s.items[0]?.status === 'needs-reply')
    const runId = waiting.items[0].runId!
    // The remote reply takes the queue path (the item goes running) into the same fake agent process.
    now += 3000
    const reply = await send('run.reply', { runId, text: 'approve' })
    expect(reply.result.ok).toBe(true)
    await until((s) => s.items[0].status === 'needs-reply')
    const events = await readEvents(ws, runId)
    const texts = events.filter((e) => (e as { subtype?: string }).subtype === 'user_message').map((e) => (e as { text: string }).text)
    expect(texts).toContain('approve')
    // run.get pages the transcript and carries no job description, notes or session id.
    const page = await send('run.get', { runId })
    const run = (page.result.body as RunPage).run
    expect(run.status).toBe('waiting')
    // The run DTO carries no job description, notes, URL, session id or output folder (the transcript's
    // own text — the prompt the agent saw — is what `run.get` exists to show, see the ADR's data table).
    expect(JSON.stringify(run)).not.toMatch(/MARKER|sessionId|outputFolder|jobDescription|notes|jobUrl/)
    expect((page.result.body as RunPage).items.some((i) => i.kind === 'user' && i.text === 'approve')).toBe(true)
  }, 20_000)

  it('rate-limits enqueue at once per 10 s and replies at once per 2 s per run; caps text at LIMITS.textBytes', async () => {
    jobs.set('url:a', job('url:a'))
    jobs.set('url:b', job('url:b'))
    await queue.setPaused(true)
    expect((await send('queue.enqueue', { jobIds: ['url:a'], options: { coverLetter: false, dateStyle: 'right' } })).result.ok).toBe(true)
    await queue.setPaused(true)
    const second = await send('queue.enqueue', { jobIds: ['url:b'], options: { coverLetter: false, dateStyle: 'right' } })
    expect(second.result.error?.code).toBe('rate-limited')
    now += 10_001
    await queue.setPaused(true)
    expect((await send('queue.enqueue', { jobIds: ['url:b'], options: { coverLetter: false, dateStyle: 'right' } })).result.ok).toBe(true)
    await queue.setPaused(true)

    const r1 = await send('run.reply', { runId: '20260930-010203-a1b2c3', text: 'x' })
    expect(r1.result.error?.code).toBe('failed') // no such run, but it passed the rate check
    const r2 = await send('run.reply', { runId: '20260930-010203-a1b2c3', text: 'x' })
    expect(r2.result.error?.code).toBe('rate-limited')
    const other = await send('run.reply', { runId: '20260930-010203-ffffff', text: 'x' })
    expect(other.result.error?.code).toBe('failed')

    const tooLong = await send('run.reply', { runId: '20260930-010203-eeeeee', text: 'y'.repeat(LIMITS.textBytes + 1) })
    expect(tooLong.result.error?.code).toBe('invalid')
    const notes = await send('queue.enqueue', { jobIds: ['url:a'], options: { coverLetter: false, dateStyle: 'right', notes: 'n'.repeat(LIMITS.textBytes + 1) } }, { ts: new Date((now += 20_000)).toISOString() })
    expect(notes.result.error?.code).toBe('invalid')
  })

  it('refuses a bad item id, a bad run id and a model / agent outside the enum with invalid', async () => {
    expect((await send('queue.cancel', { itemId: '../etc' })).result.error?.code).toBe('failed') // requireItemId throws a desktop error → generic failed
    expect((await send('run.stop', { runId: '/tmp/x' })).result.error?.code).toBe('failed')
    expect((await send('queue.enqueue', { jobIds: ['url:a'], options: { coverLetter: false, dateStyle: 'right' }, agent: 'gpt-5' })).result.error?.code).toBe('invalid')
    expect((await send('queue.enqueue', { jobIds: ['url:a'], options: { coverLetter: false, dateStyle: 'right' }, model: 'opus' })).result.error?.code).toBe('invalid')
  })
})

describe('Gateway: jobs.addUrl and file.get', () => {
  it('runs assertPublicUrl: a public name resolving to loopback or a private address is refused before any fetch', async () => {
    const evil = await send('jobs.addUrl', { url: 'https://evil.example.com/job' })
    expect(evil.result.ok).toBe(false)
    expect(addedUrls).toEqual([])
    const priv = await send('jobs.addUrl', { url: 'https://intranet.example.com/job' })
    expect(priv.result.ok).toBe(false)
    const literal = await send('jobs.addUrl', { url: 'http://127.0.0.1:8080/job' })
    expect(literal.result.error?.code).toBe('invalid') // the package guard already refuses the shape
    expect(addedUrls).toEqual([])
    const ok = await send('jobs.addUrl', { url: 'https://jobs.example.com/1' })
    expect(ok.result.ok).toBe(true)
    expect(addedUrls).toEqual(['https://jobs.example.com/1'])
    expect(JSON.stringify(ok.result.body)).not.toContain('MARKER_DESCRIPTION')
  })

  it('serves a file in 24 KiB chunks with the whole-file sha256 on each', async () => {
    const folder = join(ws, 'engineer', 'acme', '42')
    await mkdir(folder, { recursive: true })
    const data = Buffer.alloc(LIMITS.fileChunkBytes + 100, 7)
    await writeFile(join(folder, 'resume.pdf'), data)
    const c0 = (await send('file.get', { applicationId: 'engineer/acme/42', file: 'resume.pdf', chunk: 0 })).result.body as FileChunk
    const c1 = (await send('file.get', { applicationId: 'engineer/acme/42', file: 'resume.pdf', chunk: 1 })).result.body as FileChunk
    expect(c0.of).toBe(2)
    expect(c0.bytes).toBe(data.length)
    expect(c0.sha256).toBe(c1.sha256)
    expect(Buffer.concat([Buffer.from(c0.data, 'base64'), Buffer.from(c1.data, 'base64')]).equals(data)).toBe(true)
    expect((await send('file.get', { applicationId: 'engineer/acme/42', file: 'resume.pdf', chunk: 2 })).result.error?.code).toBe('invalid')
    expect((await send('file.get', { applicationId: 'engineer/acme/42', file: '../master-profile.md', chunk: 0 })).result.error?.code).toBe('invalid')
  })
})

describe('Gateway: redelivery identity, revocation, storage failures and workspace binding', () => {
  const at = () => new Date(now).toISOString()
  const handle = (env: Envelope, record = devices.get(phone.id)!) => gateway.handle(record, env)

  it('answers only an exact redelivery from the log: a reused read id with another seq is refused', async () => {
    const read = command(phone, 'queue.get', undefined, identity.id, { ts: at() })
    expect((await handle(read)).result.ok).toBe(true)
    const rewound = { ...read, seq: 0 }
    const reply = await handle(rewound)
    expect(reply.result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    // A reused id is refused as such; the device is not marked for a counter it never rewound.
    expect(devices.get(phone.id)!.needsRepair).toBe(false)
    expect((await handle(read)).result.ok).toBe(true) // the exact redelivery still answers
  })

  it('refuses a finished write id reused with another body or workspace, without running it', async () => {
    await queue.setPaused(false)
    const pause = command(phone, 'queue.setPaused', { paused: true }, identity.id, { ts: at() })
    expect((await handle(pause)).result.ok).toBe(true)
    await queue.setPaused(false)
    const otherBody = { ...pause, body: { paused: false } }
    expect((await handle(otherBody)).result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    const otherWs = { ...pause, ws: 'b'.repeat(32) }
    expect((await handle(otherWs)).result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(queue.state().paused).toBe(false)
    const exact = await handle(pause)
    expect(exact.result.ok).toBe(true)
    expect(queue.state().paused).toBe(false) // answered from the log, not run again
  })

  it("does not answer one device's id from another device's log entry", async () => {
    await queue.setPaused(false)
    const pause = command(phone, 'queue.setPaused', { paused: true }, identity.id, { ts: at() })
    await handle(pause)
    const other = fakePhone((await devices.keyPair())!, 'Other')
    await devices.add(other.record)
    const theirs = command(other, 'queue.setPaused', { paused: false }, identity.id, { ts: at(), id: pause.id })
    const reply = await gateway.handle(devices.get(other.id)!, theirs)
    // Its own command under its own seq: it runs (unpause), it is not handed the first phone's stored result.
    expect(reply.result.ok).toBe(true)
    expect((reply.result.body as RemoteQueueState).paused).toBe(false)
    expect(queue.state().paused).toBe(false)
  })

  it('denies a command from a device removed after the frame was queued (stale record)', async () => {
    await queue.setPaused(false)
    const stale = devices.get(phone.id)!
    await devices.remove(phone.id)
    const reply = await handle(command(phone, 'queue.setPaused', { paused: true }, identity.id, { ts: at() }), stale)
    expect(reply.result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(queue.state().paused).toBe(false)
  })

  it('denies a command queued behind a slow one when the device is revoked meanwhile', async () => {
    await queue.setPaused(false)
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const inside = new Promise<void>((r) => (reached = r))
    const setPaused = services.queue.setPaused
    services.queue.setPaused = async (w, p) => {
      if (p) {
        reached()
        await gate
      }
      return setPaused(w, p)
    }
    const record = devices.get(phone.id)!
    const first = handle(command(phone, 'queue.setPaused', { paused: true }, identity.id, { ts: at() }), record)
    const second = handle(command(phone, 'queue.setPaused', { paused: false }, identity.id, { ts: at() }), record)
    await inside
    await devices.remove(phone.id) // Settings → Revoke while the first command runs
    release()
    expect((await first).result.ok).toBe(true)
    expect((await second).result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(queue.state().paused).toBe(true) // the queued unpause never ran
  })

  it('a re-pair under the same id with a new key denies frames of the old pairing', async () => {
    const stale = devices.get(phone.id)!
    const repaired = fakePhone((await devices.keyPair())!, 'Same phone', phone.id)
    await devices.add(repaired.record)
    const reply = await handle(command(phone, 'queue.get', undefined, identity.id, { ts: at() }), stale)
    expect(reply.result.error?.code).toBe('denied')
  })

  it('after a restart, a phone paired again under the same id is not held to the old pairing’s seq', async () => {
    for (let i = 0; i < 3; i++) expect((await send('queue.get')).result.ok).toBe(true)
    // Paired again: same device id, new keys and sid, counter back at 0.
    const repaired = fakePhone((await devices.keyPair())!, 'Same phone', phone.id)
    await devices.add(repaired.record)
    await devices.flush()
    const reloaded = new DeviceStore(dir, fakeCipher())
    await reloaded.load()
    const restarted = new Gateway(services, reloaded)
    const reply = await restarted.handle(reloaded.get(phone.id)!, command(repaired, 'queue.get', undefined, identity.id, { ts: at() }))
    expect(reply.result.ok).toBe(true)
    expect(reloaded.get(phone.id)!.needsRepair).toBe(false)
    expect(reloaded.get(phone.id)!.lastSeq).toBe(1)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects (so the frame is not acked) when the write-ahead entry cannot be written, and runs once after', async () => {
    await queue.setPaused(false)
    const pause = command(phone, 'queue.setPaused', { paused: true }, identity.id, { ts: at() })
    await chmod(join(ws, '.huntgry'), 0o500)
    try {
      await expect(handle(pause)).rejects.toBeInstanceOf(DurabilityError)
    } finally {
      await chmod(join(ws, '.huntgry'), 0o700)
    }
    expect(queue.state().paused).toBe(false)
    expect(devices.get(phone.id)!.lastSeq).toBe(0)
    const redelivered = await handle(pause)
    expect(redelivered.result.ok).toBe(true)
    expect(queue.state().paused).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects when the lastSeq checkpoint cannot be written; the redelivery is not run twice', async () => {
    await queue.setPaused(false)
    const pause = command(phone, 'queue.setPaused', { paused: true }, identity.id, { ts: at() })
    await chmod(dir, 0o500)
    try {
      await expect(handle(pause)).rejects.toBeInstanceOf(DurabilityError)
    } finally {
      await chmod(dir, 0o700)
    }
    expect(queue.state().paused).toBe(false) // nothing ran after the failed checkpoint
    const again = await handle(pause)
    expect(again.result.error?.message).toMatch(/interrupted/i)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects when the outcome cannot be written after a real mutation; the redelivery answers interrupted', async () => {
    await queue.setPaused(false)
    crashAt = (step) => {
      if (step === 'after-execute') return chmodSync(auditFile(ws), 0o400)
    }
    const pause = command(phone, 'queue.setPaused', { paused: true }, identity.id, { ts: at() })
    try {
      await expect(handle(pause)).rejects.toBeInstanceOf(DurabilityError)
    } finally {
      chmodSync(auditFile(ws), 0o600)
      crashAt = undefined
    }
    expect(queue.state().paused).toBe(true)
    await queue.setPaused(false)
    const again = await handle(pause)
    expect(again.result.error?.message).toMatch(/interrupted/i)
    expect(queue.state().paused).toBe(false) // not run a second time
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects a refused frame whose audit line cannot be written instead of acking it unrecorded', async () => {
    await send('queue.get') // creates the log
    chmodSync(auditFile(ws), 0o400)
    try {
      await expect(handle(command(phone, 'queue.get', undefined, 'b'.repeat(32), { ts: at() }))).rejects.toBeInstanceOf(DurabilityError)
      await expect(gateway.recordRejected(devices.get(phone.id)!, 'ref-1', { code: 'denied', message: 'x' })).rejects.toBeInstanceOf(DurabilityError)
    } finally {
      chmodSync(auditFile(ws), 0o600)
    }
  })

  it('does not run a command on a workspace the owner switched to during the audit fsync', async () => {
    await queue.setPaused(false)
    const other = await mkdtemp(join(tmpdir(), 'huntgry-gw-other-'))
    const otherIdentity = await workspaceIdentity(other)
    crashAt = (step) => {
      if (step === 'after-start') identity = otherIdentity
    }
    try {
      const reply = await send('queue.setPaused', { paused: true })
      expect(reply.result).toMatchObject({ ok: false, error: { code: 'invalid' } })
      expect(reply.result.error?.message).toMatch(/workspace/i)
      expect(queue.state().paused).toBe(false)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('refuses a file over the size cap before reading it, and re-hashes a changed file', async () => {
    const folder = join(ws, 'engineer', 'acme', '42')
    await mkdir(folder, { recursive: true })
    const big = join(folder, 'cover.pdf')
    await writeFile(big, '')
    await truncate(big, MAX_REMOTE_FILE_BYTES + 1) // sparse: no real 32 MB written
    const refused = await send('file.get', { applicationId: 'engineer/acme/42', file: 'cover.pdf', chunk: 0 })
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(refused.result.error?.message).toMatch(/larger than/)
    const small = join(folder, 'resume.pdf')
    await writeFile(small, Buffer.alloc(100, 1))
    const a = (await send('file.get', { applicationId: 'engineer/acme/42', file: 'resume.pdf', chunk: 0 })).result.body as FileChunk
    await writeFile(small, Buffer.alloc(120, 2))
    const b = (await send('file.get', { applicationId: 'engineer/acme/42', file: 'resume.pdf', chunk: 0 })).result.body as FileChunk
    expect(a.sha256).not.toBe(b.sha256)
    expect(b.bytes).toBe(120)
    expect(Buffer.from(b.data, 'base64').equals(Buffer.alloc(120, 2))).toBe(true)
  })
})

describe('Gateway: execution stays bound to the checked workspace', () => {
  let other: string
  beforeEach(async () => {
    other = await mkdtemp(join(tmpdir(), 'huntgry-gw-other-'))
    await workspaceIdentity(other)
    await queue.setPaused(false)
  })
  afterEach(() => rm(other, { recursive: true, force: true }))

  it('a switch that lands after the gateway check never pauses the other workspace’s queue', async () => {
    // The gateway's own re-check still sees the checked workspace; the app switches right after it.
    crashAt = (step) => {
      if (step === 'after-start') openWs = other
    }
    const reply = await send('queue.setPaused', { paused: true })
    expect(reply.result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(reply.result.error?.message).toMatch(/workspace open on the Mac changed/)
    // The queue never loaded the other workspace, let alone paused it.
    expect(queue.workspace()).toBe(ws)
    expect(queue.state().paused).toBe(false)
    expect(existsSync(queueFile(other))).toBe(false)
    // Recorded under the checked workspace's log as a failed outcome, not run.
    expect((await auditLines()).at(-1)).toMatchObject({ name: 'queue.setPaused', ok: false })
  })

  it('a read does not answer with the other workspace’s queue', async () => {
    openWs = other
    const reply = await send('queue.get')
    expect(reply.result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(queue.workspace()).toBe(ws)
  })

  it('enqueue stops when the desktop loads another workspace while it looks jobs up', async () => {
    jobs.set('url:a', job('url:a'))
    jobs.set('url:b', job('url:b'))
    let switched = false
    onFindJob = async () => {
      if (switched) return
      switched = true
      openWs = other
      await queue.sync() // the desktop opens the other workspace mid-command
    }
    const reply = await send('queue.enqueue', { jobIds: ['url:a', 'url:b'], options: { coverLetter: false, dateStyle: 'right' } })
    expect(reply.result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(queue.workspace()).toBe(other)
    expect(queue.state().items).toEqual([]) // nothing added to the other workspace's queue
  })

  it('passes the checked workspace path to every run service call', async () => {
    await send('runs.list', {})
    expect(runsCalls).toEqual([ws])
  })
})

