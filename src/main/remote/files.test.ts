import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import { COMMAND_TTL_SECONDS, LIMITS, requireEvent, type Envelope, type FileChunk, type RemoteCommandName, type RemoteEventName, type RemoteJob, type RemotePage } from '@shared/remote'
import { resolveApplicationFile } from '../applications/safe-path'
import { WorkspaceWatcher } from '../applications/watch'
import { DeviceStore } from './devices'
import { RemoteEvents } from './events'
import { FILE_CHUNK_TTL_SECONDS, Gateway, type GatewayServices } from './gateway'
import { command, fakeCipher, fakePhone, job, queueState, type FakePhone } from './test-helpers'
import { workspaceIdentity, type WorkspaceIdentity } from './workspace'

/**
 * #40: files and jobs from the phone, through the gateway with the desktop's real
 * `resolveApplicationFile` (#24's confinement: the id's shape, a real folder inside the
 * workspace, a known regular file, symlinks refused).
 */

const FIXTURE = join(__dirname, '../../../e2e/fixtures/workspaces/demo/platform-engineer/initech/init-9')
const APP = 'platform-engineer/initech/init-9'
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

let ws: string
let outside: string
let dir: string
let identity: WorkspaceIdentity
let devices: DeviceStore
let phone: FakePhone
let gateway: Gateway
let services: GatewayServices
let jobs: Job[]
let added: string[]
let addResult: () => Promise<Job>
let now: number

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-files-ws-'))
  outside = await mkdtemp(join(tmpdir(), 'huntgry-files-outside-'))
  dir = await mkdtemp(join(tmpdir(), 'huntgry-files-user-'))
  await cp(FIXTURE, join(ws, APP), { recursive: true })
  identity = await workspaceIdentity(ws)
  devices = new DeviceStore(dir, fakeCipher())
  await devices.load()
  phone = fakePhone((await devices.keyPair())!)
  await devices.add(phone.record)
  jobs = []
  added = []
  addResult = async () => job('url:added')
  now = Date.parse('2026-10-09T12:00:00.000Z')
  services = {
    desktopName: 'Test Mac',
    appVersion: '0.1.0-test',
    workspace: async () => identity,
    agents: async () => [],
    defaultAgent: async () => 'claude',
    queue: {
      state: async () => queueState(),
      setPaused: async () => queueState(),
      cancel: async () => queueState(),
      retry: async () => queueState(),
      enqueue: async () => ({ added: 0, skipped: [], state: queueState() }),
      reply: async () => null
    },
    runs: {
      list: async () => [],
      get: async () => {
        throw new Error('unused')
      },
      reply: async () => {
        throw new Error('unused')
      },
      stop: async () => {
        throw new Error('unused')
      },
      finish: async () => {
        throw new Error('unused')
      }
    },
    jobs: {
      list: async () => jobs,
      addUrl: async (_ws, url) => {
        added.push(url)
        return addResult()
      }
    },
    // The app's wiring (remote/ipc.ts): the applications' safe-path rules.
    files: { resolve: resolveApplicationFile },
    transcripts: () => true,
    resolveHost: async (host) => (host === 'jobs.example.com' ? ['93.184.216.34'] : host === 'evil.example.com' ? ['127.0.0.1'] : ['10.0.0.5']),
    now: () => now
  }
  gateway = new Gateway(services, devices)
})

afterEach(async () => {
  await devices.flush()
  for (const d of [ws, outside, dir]) await rm(d, { recursive: true, force: true })
})

const send = (name: RemoteCommandName, args?: unknown, over: Partial<Envelope> = {}, wsId: string = identity.id) => {
  // Keep well under the 30 reads / minute limit however many requests a test makes.
  now += 3_000
  return gateway.handle(devices.get(phone.id)!, command(phone, name, args, wsId, { ts: new Date(now).toISOString(), ...over }))
}
const chunk = async (file: string, n = 0, applicationId = APP) => (await send('file.get', { applicationId, file, chunk: n })).result

/** Fetches every chunk the way the phone does and checks the reassembled bytes against the hash. */
async function fetchAll(file: string): Promise<{ bytes: Buffer; chunks: FileChunk[] }> {
  const first = (await chunk(file)).body as FileChunk
  const chunks = [first]
  for (let i = 1; i < first.of; i++) chunks.push((await chunk(file, i)).body as FileChunk)
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')))
  expect(bytes.length).toBe(first.bytes)
  expect(sha256(bytes)).toBe(first.sha256)
  return { bytes, chunks }
}

describe('file.get (#40)', () => {
  it('serves a built application’s PDF and page preview in one chunk each, with the whole-file sha256', async () => {
    for (const file of ['resume.pdf', 'cover.pdf', 'resume-page-1.jpg', 'cover-page-1.jpg']) {
      const disk = await readFile(join(FIXTURE, file))
      const { bytes, chunks } = await fetchAll(file)
      expect(bytes.equals(disk)).toBe(true)
      expect(chunks[0]).toMatchObject({ applicationId: APP, file, chunk: 0, of: 1, bytes: disk.length, sha256: sha256(disk) })
    }
    // A chunk waits at the relay 10 minutes at most (the command itself may wait 24 h); other reads keep their ttl.
    expect((await chunk('resume.pdf')).ttl).toBe(FILE_CHUNK_TTL_SECONDS)
    expect((await send('jobs.list', {})).result.ttl).toBe(COMMAND_TTL_SECONDS.default)
  })

  it('splits a larger file into 24 KiB chunks, each carrying the hash of the whole file', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), createHash('sha512').update('x').digest(), Buffer.alloc(60_000 - 9 - 64, 0x41)])
    await writeFile(join(ws, APP, 'resume.pdf'), pdf)
    const { bytes, chunks } = await fetchAll('resume.pdf')
    expect(bytes.equals(pdf)).toBe(true)
    expect(chunks.map((c) => Buffer.from(c.data, 'base64').length)).toEqual([LIMITS.fileChunkBytes, LIMITS.fileChunkBytes, 60_000 - 2 * LIMITS.fileChunkBytes])
    expect(new Set(chunks.map((c) => c.sha256))).toEqual(new Set([sha256(pdf)]))
    expect(chunks.map((c) => c.of)).toEqual([3, 3, 3])
    expect((await chunk('resume.pdf', 3)).error?.code).toBe('invalid')
    // The file is regenerated: the next chunk carries the new hash, so the phone's reassembly fails and it starts over.
    await writeFile(join(ws, APP, 'resume.pdf'), Buffer.concat([pdf, Buffer.from('changed')]))
    expect(((await chunk('resume.pdf', 1)).body as FileChunk).sha256).not.toBe(sha256(pdf))
  })

  it('serves review-notes.md and nothing else of the folder or the workspace', async () => {
    await writeFile(join(ws, APP, 'review-notes.md'), '# Review notes\n')
    expect(((await chunk('review-notes.md')).body as FileChunk).bytes).toBe(15)
    await writeFile(join(ws, 'master-profile.md'), 'private')
    for (const file of ['huntgry.json', 'build-report.json', 'resume_data.json', 'job-description.md', 'resume.tex', 'master-profile.md', '../../../master-profile.md', 'resume-page-1.png']) {
      const r = await chunk(file)
      expect(r.error?.code, file).toBe('invalid')
    }
    for (const id of ['../../..', 'platform-engineer/initech', 'platform-engineer/initech/init-9/extra', '/etc/passwd/x', 'platform-engineer/../initech', '.huntgry/jobs/x']) {
      const r = await chunk('resume.pdf', 0, id)
      expect(r.error?.code, id).toBe('invalid')
    }
  })

  it('refuses symlinks: a linked file, a linked application folder, and a link swapped in after the check', async () => {
    await writeFile(join(outside, 'resume.pdf'), 'outside the workspace')
    await unlink(join(ws, APP, 'cover.pdf'))
    await symlink(join(outside, 'resume.pdf'), join(ws, APP, 'cover.pdf'))
    expect((await chunk('cover.pdf')).error?.code).toBe('invalid')
    await mkdir(join(ws, 'linked', 'acme'), { recursive: true })
    await symlink(outside, join(ws, 'linked', 'acme', 'x-1'))
    expect((await chunk('resume.pdf', 0, 'linked/acme/x-1')).error?.code).toBe('invalid')
    // A directory named like a file, and a missing file.
    await mkdir(join(ws, APP, 'resume-page-2.jpg'))
    expect((await chunk('resume-page-2.jpg')).error?.code).toBe('invalid')
    expect((await chunk('cover-page-9.jpg')).error?.code).toBe('invalid')
    // The check passed, then the file became a symlink before it was opened: O_NOFOLLOW refuses it.
    services.files.resolve = async (w, id, file) => {
      const path = await resolveApplicationFile(w, id, file)
      await unlink(path)
      await symlink(join(outside, 'resume.pdf'), path)
      return path
    }
    const swapped = await chunk('resume.pdf')
    expect(swapped.error?.code).toBe('invalid')
    expect(JSON.stringify(swapped)).not.toContain('outside the workspace')
  })
})

describe('jobs.list and jobs.addUrl (#40)', () => {
  it('pages the saved jobs at 50 with the projected DTO, dismissed and tailored flagged, never the description', async () => {
    jobs = Array.from({ length: 120 }, (_, i) => job(`url:${String(i).padStart(4, '0')}`, { dismissed: i === 3, tailoredAt: i === 4 ? '2026-10-01T00:00:00.000Z' : undefined }))
    const pages: RemotePage<RemoteJob>[] = []
    let cursor: string | undefined
    do {
      const reply = await send('jobs.list', cursor ? { cursor } : {})
      expect(reply.result.ok).toBe(true)
      pages.push(reply.result.body as RemotePage<RemoteJob>)
      cursor = pages.at(-1)!.nextCursor
    } while (cursor)
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 20])
    const all = pages.flatMap((p) => p.items)
    expect(all.map((j) => j.id)).toEqual(jobs.map((j) => j.id))
    expect(all[3].dismissed).toBe(true)
    expect(all[4].tailored).toBe(true)
    expect(Object.keys(all[0]).sort()).toEqual(['company', 'id', 'location', 'savedAt', 'source', 'title'])
    expect(JSON.stringify(pages)).not.toContain('MARKER_DESCRIPTION')
    const filtered = (await send('jobs.list', { filter: '0042' })).result.body as RemotePage<RemoteJob>
    expect(filtered.items.map((j) => j.id)).toEqual(['url:0042'])
  })

  it('refuses private, loopback and non-http(s) URLs like the desktop, before any fetch', async () => {
    for (const url of ['ftp://jobs.example.com/1', 'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/job', 'http://10.0.0.1/job', 'https://printer.local/job', 'https://user:pw@jobs.example.com/1']) {
      expect((await send('jobs.addUrl', { url })).result.error?.code, url).toBe('invalid')
    }
    const resolvesPrivate = await send('jobs.addUrl', { url: 'https://evil.example.com/job' })
    expect(resolvesPrivate.result.error).toEqual({ code: 'invalid', message: 'Refusing to load evil.example.com: it is a local or private-network address.' })
    expect(added).toEqual([])
  })

  it('returns the saved job under its canonical id, and the desktop’s own refusal as it reads on the Mac', async () => {
    addResult = async () => job('url:new', { title: 'Platform Engineer' })
    jobs = [job('url:canon', { title: 'Platform Engineer', aliases: ['url:new'] })]
    const reply = await send('jobs.addUrl', { url: 'https://jobs.example.com/9' })
    expect(reply.result.ok).toBe(true)
    expect(reply.result.body).toMatchObject({ id: 'url:canon', title: 'Platform Engineer', source: 'url' })
    expect(JSON.stringify(reply.result.body)).not.toMatch(/MARKER_DESCRIPTION|jobs\.example\.com/)
    expect(added).toEqual(['https://jobs.example.com/9'])
    addResult = async () => {
      throw new Error('No job posting was found on that page. Paste the description instead.')
    }
    now += 11_000
    const refused = await send('jobs.addUrl', { url: 'https://jobs.example.com/10' })
    expect(refused.result.error).toEqual({ code: 'failed', message: 'No job posting was found on that page. Paste the description instead.' })
  })

  it('all three commands carry ws and are refused for another workspace (after a switch)', async () => {
    jobs = [job('url:a')]
    const stale = 'f'.repeat(32)
    for (const [name, args] of [
      ['file.get', { applicationId: APP, file: 'resume.pdf', chunk: 0 }],
      ['jobs.list', {}],
      ['jobs.addUrl', { url: 'https://jobs.example.com/1' }]
    ] as const) {
      const r = await send(name, args, {}, stale)
      expect(r.result.error?.code, name).toBe('invalid')
      expect(r.result.error?.message, name).toMatch(/workspace changed/i)
      const missing = await gateway.handle(devices.get(phone.id)!, command(phone, name, args, undefined, { ts: new Date((now += 3000)).toISOString() }))
      expect(missing.result.error?.code, `${name} without ws`).toBe('invalid')
    }
    expect(added).toEqual([])
  })
})

describe('applications.changed (#40)', () => {
  it('reaches the phone when the workspace watcher fires', async () => {
    const sent: { name: RemoteEventName; body: unknown }[] = []
    const events = new RemoteEvents({
      broadcast: async (name, body) => {
        requireEvent(name, body)
        sent.push({ name, body })
      },
      status: async () => {
        throw new Error('unused')
      }
    })
    // The app's wiring: applications/ipc.ts's watcher emits applications:changed, remote/ipc.ts forwards it.
    const watcher = new WorkspaceWatcher(() => void events.handle('applications:changed', null), 50)
    watcher.watch(ws)
    try {
      await new Promise((r) => setTimeout(r, 100))
      await writeFile(join(ws, APP, 'resume-page-2.jpg'), 'jpg')
      const t0 = Date.now()
      while (!sent.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20))
      expect(sent[0]).toEqual({ name: 'applications.changed', body: { ids: [] } })
    } finally {
      watcher.close()
    }
  })
})
