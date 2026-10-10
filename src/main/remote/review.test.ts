import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LIMITS,
  jsonBytes,
  openEnvelope,
  requireEnvelope,
  requireEvent,
  requireRelayFrame,
  sealEnvelope,
  type Envelope,
  type RelayFrame,
  type RemoteCommandName,
  type RemoteEventName,
  type ReviewDetail,
  type ReviewList
} from '@shared/remote'
import { approvalsFile, loadApprovals } from '../review/approvals'
import { getReview, setReviewAuthorityRoot, updateReview, type RecordedReview } from '../review/authority'
import { reframingId } from '../review/notes'
import { IN_PROGRESS_REASON } from '../pipeline/pipeline'
import {
  approveReview,
  discardReview,
  isSettledReview,
  listReviews,
  openGapCount,
  rerunReview,
  REVIEW_AUDIT_FILE,
  reviewDetail,
  type ReviewDeps
} from '../review/service'
import { auditFile } from './audit'
import { DeviceStore } from './devices'
import { RemoteEvents } from './events'
import { Gateway, pendingReviews, statusOf, type GatewayServices } from './gateway'
import { projectReviewDetail } from './project'
import { RemoteSession, type SocketLike } from './session'
import { command, fakeCipher, fakePhone, queueState, type FakePhone } from './test-helpers'
import { workspaceIdentity, type WorkspaceIdentity } from './workspace'

/**
 * #42: review from the phone, through the gateway onto the desktop's review service, with
 * revision-bound decisions: the detail is pinned by the desktop's revision, a decision on
 * anything else is `stale`, on a revision this phone was never shown `denied`, and a reframing
 * id outside what it was shown `invalid`, with nothing written.
 */

const RUN = '20261009-120000-abcdef'
const RUN_B = '20261009-130000-bbbbbb'
const A = 'software-engineer/acme/42'
const B = 'platform-engineer/initech/9'
const notes = (run: string, reframings: [string, string][], gaps: string[], tail = 'Fake.') => `# Review notes
<!-- huntgry-review v1 · run ${run} · unattended -->

## Used standing approvals
None.

## Proposed reframings (not used)
${reframings.map(([fact, wording], i) => `### R${i + 1} · Requirement ${i + 1}\n- Source fact: ${fact}\n- Proposed wording: ${wording}\n- Why unsure: not sure\n`).join('\n')}
## Open gaps
${gaps.map((g) => `- ${g}`).join('\n')}

## Notes
${tail}
`
const R1: [string, string] = ['Built an event pipeline on RabbitMQ', 'Built event-streaming pipelines (RabbitMQ; Kafka-adjacent)']
const R2: [string, string] = ['Mentored two juniors', 'Led a team of two engineers']
const R3: [string, string] = ['Ran the on-call rotation', 'Owned production reliability']
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

let ws: string
let authority: string
let dir: string
let identity: WorkspaceIdentity
let devices: DeviceStore
let phone: FakePhone
let other: FakePhone
let gateway: Gateway
let services: GatewayServices
let replies: { runId: string; text: string }[]
let changes: number
let now: number

async function application(id: string, over: { notes?: string; review?: Partial<RecordedReview>; report?: string } = {}): Promise<string> {
  const folder = join(ws, ...id.split('/'))
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'job-description.md'), 'Engineer\nhttps://jobs.example.com/42\n')
  await writeFile(join(folder, 'resume.pdf'), `%PDF-1.4 ${id}`)
  await writeFile(join(folder, 'cover.pdf'), `%PDF-1.4 cover ${id}`)
  await writeFile(join(folder, 'resume-page-1.jpg'), 'jpg 1')
  await writeFile(join(folder, 'cover-page-1.jpg'), 'jpg c1')
  await writeFile(join(folder, 'build-report.json'), over.report ?? '{"ok": true, "checks": {"page_count": "pass"}}')
  await writeFile(join(folder, 'review-notes.md'), over.notes ?? notes(RUN, [R1, R2], ['Go: nothing honest to say']))
  await writeFile(join(folder, 'huntgry.json'), JSON.stringify({ status: 'generated', notes: '', role: 'Software Engineer', company: 'Acme' }))
  await updateReview(ws, id, () => ({ state: 'unreviewed', runId: RUN, at: '2026-10-09T11:00:00.000Z', ...over.review }) as RecordedReview)
  return folder
}

function reviewDeps(w: string): ReviewDeps {
  return {
    workspace: async () => w,
    reply: async (runId, text) => {
      replies.push({ runId, text })
      return 'held'
    },
    // The app passes afterReviewDecision here (review/ipc.ts reviewDepsFor).
    changed: () => void changes++,
    now: () => new Date(now)
  }
}

function makeServices(): GatewayServices {
  return {
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
    runs: { list: async () => [], get: async () => ({ run: {} as never, items: [] }), reply: async () => ({}) as never, stop: async () => ({}) as never, finish: async () => ({}) as never },
    jobs: { list: async () => [], addUrl: async () => ({}) as never },
    files: { resolve: async () => '' },
    // The same calls as reviewForRemote in review/ipc.ts.
    review: {
      list: async (w) => Promise.all((await listReviews(w)).map(async (item) => ({ item, openGaps: await openGapCount(w, item.applicationId) }))),
      detail: (w, id) => reviewDetail(w, id),
      approve: (w, input, via) => approveReview(reviewDeps(w), input, via),
      rerun: (w, input, via) => rerunReview(reviewDeps(w), input, via),
      discard: (w, input, via) => discardReview(reviewDeps(w), input, via),
      unreviewed: async (w) => (await listReviews(w)).filter(isSettledReview).length
    },
    transcripts: () => true,
    now: () => now
  }
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-rreview-ws-'))
  authority = await mkdtemp(join(tmpdir(), 'huntgry-rreview-auth-'))
  dir = await mkdtemp(join(tmpdir(), 'huntgry-rreview-user-'))
  setReviewAuthorityRoot(authority)
  identity = await workspaceIdentity(ws)
  devices = new DeviceStore(dir, fakeCipher())
  await devices.load()
  phone = fakePhone((await devices.keyPair())!)
  other = fakePhone((await devices.keyPair())!, 'Other iPhone')
  await devices.add(phone.record)
  await devices.add(other.record)
  replies = []
  changes = 0
  now = Date.parse('2026-10-09T12:00:00.000Z')
  services = makeServices()
  gateway = new Gateway(services, devices)
})

afterEach(async () => {
  await devices.flush()
  for (const d of [ws, authority, dir]) await rm(d, { recursive: true, force: true })
})

const send = (name: RemoteCommandName, args?: unknown, from: FakePhone = phone) => {
  now += 3_000
  return gateway.handle(devices.get(from.id)!, command(from, name, args, identity.id, { ts: new Date(now).toISOString() }))
}
const get = async (id = A, from: FakePhone = phone) => (await send('review.get', { applicationId: id }, from)).result.body as ReviewDetail
const approvalsOnDisk = () => readFile(approvalsFile(ws), 'utf8').catch(() => null)
const idOf = ([fact, wording]: [string, string]) => reframingId(fact, wording)

describe('review.list and review.get (#42)', () => {
  it('lists the results waiting for review, newest first, with open gaps, state and reason, never a path', async () => {
    await application(A)
    await application(B, { review: { state: 'needs-attention', at: '2026-10-09T11:30:00.000Z', reason: 'Failed checks: page_count.', runId: RUN_B }, notes: notes(RUN_B, [R3], ['Go', 'Rust']) })
    await application('x/y/approved', { review: { state: 'approved' } })
    const list = (await send('review.list')).result.body as ReviewList
    expect(list.items).toEqual([
      { applicationId: B, runId: RUN_B, title: 'Platform Engineer · Initech', openGaps: 2, finishedAt: '2026-10-09T11:30:00.000Z', state: 'needs-attention', reason: 'Failed checks: page_count.' },
      { applicationId: A, runId: RUN, title: 'Software Engineer · Acme', openGaps: 1, finishedAt: '2026-10-09T11:00:00.000Z', state: 'unreviewed' }
    ])
    expect(JSON.stringify(list)).not.toContain(ws)
  })

  it('builds ReviewDetail from disk: notes inline, gaps, reframing ids sha256(sourceFact + "\\n" + wording), verify, artifacts with bytes and sha256', async () => {
    const folder = await application(A)
    const d = await get()
    expect(d.applicationId).toBe(A)
    expect(d.runId).toBe(RUN)
    expect(d.state).toBe('unreviewed')
    expect(d.reviewNotes).toBe(await readFile(join(folder, 'review-notes.md'), 'utf8'))
    expect(d.openGaps).toEqual(['Go: nothing honest to say'])
    expect(d.proposedReframings).toEqual([
      { id: sha256(`${R1[0]}\n${R1[1]}`), sourceFact: R1[0], wording: R1[1] },
      { id: sha256(`${R2[0]}\n${R2[1]}`), sourceFact: R2[0], wording: R2[1] }
    ])
    expect(d.verify).toEqual({ ok: true, report: '{"ok": true, "checks": {"page_count": "pass"}}' })
    expect(d.artifacts.map((a) => a.file)).toEqual(['resume.pdf', 'cover.pdf', 'resume-page-1.jpg', 'cover-page-1.jpg'])
    for (const a of d.artifacts) {
      const bytes = await readFile(join(folder, a.file))
      expect(a).toEqual({ file: a.file, bytes: bytes.length, sha256: sha256(bytes) })
    }
    // The desktop's own revision: the phone and the Review page pin the same snapshot.
    expect(d.revision).toBe((await reviewDetail(ws, A)).revision)
    expect(d.truncated).toBeUndefined()
    expect(JSON.stringify(d)).not.toContain(ws)
  })

  it('the revision changes when the notes, a gap, a reframing, the verify report or an artifact changes', async () => {
    const folder = await application(A)
    const revisions = new Set<string>()
    const step = async (label: string, change: () => Promise<void>) => {
      await change()
      const r = (await get()).revision
      expect(revisions.has(r), label).toBe(false)
      revisions.add(r)
    }
    revisions.add((await get()).revision)
    expect((await get()).revision, 'unchanged').toBe([...revisions][0])
    await step('notes', () => writeFile(join(folder, 'review-notes.md'), notes(RUN, [R1, R2], ['Go: nothing honest to say'], 'Edited.')))
    await step('gaps', () => writeFile(join(folder, 'review-notes.md'), notes(RUN, [R1, R2], ['Go: nothing honest to say', 'Rust'], 'Edited.')))
    await step('reframings', () => writeFile(join(folder, 'review-notes.md'), notes(RUN, [R1, [R2[0], 'Led two engineers']], ['Go: nothing honest to say', 'Rust'], 'Edited.')))
    await step('verify report', () => writeFile(join(folder, 'build-report.json'), '{"ok": false}'))
    await step('resume.pdf', () => writeFile(join(folder, 'resume.pdf'), '%PDF-1.4 rebuilt'))
    await step('a page preview', () => writeFile(join(folder, 'cover-page-1.jpg'), 'jpg new'))
  })

  it('fits one frame: long entries are cut and marked, a reframing that does not fit whole is left out, notes go to file.get', async () => {
    const long = 'é'.repeat(200) // 400 bytes, over reviewEntryBytes
    const many: [string, string][] = Array.from({ length: 20 }, (_, i) => [`Fact ${i} ${'\u0001'.repeat(200)}`, `Wording ${i}`])
    const folder = await application(A, { notes: notes(RUN, [[long, 'short'], R1, ...many], [long, ...Array.from({ length: 20 }, (_, i) => `Gap ${i} ${'\u0001'.repeat(200)}`)], 'x'.repeat(10_000)) })
    await writeFile(join(folder, 'build-report.json'), `{"log": "${'\u0001'.repeat(5000)}"}`)
    const desktop = await reviewDetail(ws, A)
    const d = projectReviewDetail(desktop)
    expect(d.truncated).toBe(true)
    expect(d.proposedReframings.some((p) => p.sourceFact === long)).toBe(false)
    expect(d.proposedReframings[0]).toMatchObject({ sourceFact: R1[0], wording: R1[1] })
    expect(d.proposedReframings.length).toBeLessThanOrEqual(LIMITS.reviewListItems)
    expect(d.openGaps.length).toBeLessThanOrEqual(LIMITS.reviewListItems)
    const envelope = { v: 1, sid: 's', from: 'desktop', seq: 1, ts: new Date(now).toISOString(), ttl: 60, kind: 'result', re: 'x'.repeat(128), ok: true, body: d }
    expect(jsonBytes(envelope)).toBeLessThanOrEqual(LIMITS.plaintextBytes)
    expect(d.revision).toBe(desktop.revision)
    // A reframing left out cannot be approved from the phone, even with the right revision.
    const served = await get()
    const omitted = desktop.proposedReframings.find((p) => !served.proposedReframings.some((s) => s.id === p.id))!
    const r = await send('review.approve', { applicationId: A, revision: served.revision, approvedReframingIds: [omitted.id] })
    expect(r.result.error?.code).toBe('invalid')
  })
})

describe('review.approve (#42)', () => {
  it('approves what the phone was shown: Unreviewed cleared like the desktop, only the on-disk pair saved, audited with revision and ids', async () => {
    await application(A)
    const d = await get()
    const reply = await send('review.approve', { applicationId: A, revision: d.revision, approvedReframingIds: [idOf(R1)] })
    expect(reply.result.ok).toBe(true)
    expect((reply.result.body as ReviewDetail).state).toBe('approved')
    expect(await getReview(ws, A)).toMatchObject({ state: 'approved', runId: RUN, via: `phone:${phone.id}` })
    expect(changes).toBe(1)
    const saved = await loadApprovals(ws)
    expect(saved.map((a) => [a.id, a.sourceFact, a.wording, a.via])).toEqual([[idOf(R1), R1[0], R1[1], `phone:${phone.id}`]])
    // The review service's audit and the remote audit both carry the revision and the ids.
    const reviewAudit = (await readFile(join(ws, '.huntgry', REVIEW_AUDIT_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(reviewAudit).toEqual([expect.objectContaining({ action: 'approve', applicationId: A, revision: d.revision, ids: [idOf(R1)], via: `phone:${phone.id}` })])
    const remoteAudit = (await readFile(auditFile(ws), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(remoteAudit.find((l) => l.name === 'review.approve' && l.started)).toMatchObject({ deviceId: phone.id, detail: { applicationId: A, revision: d.revision, ids: [idOf(R1)] } })
    expect(remoteAudit.find((l) => l.name === 'review.approve' && !l.started)).toMatchObject({ ok: true })
  })

  describe('refusals write nothing (standing approvals untouched, still Unreviewed)', () => {
    let before: string | null
    let revision: string
    beforeEach(async () => {
      await application(A)
      await application(B, { notes: notes(RUN_B, [R3], []), review: { runId: RUN_B } })
      // One earlier approval, so "untouched" means the bytes stay the same, not just "absent".
      await approveReview(reviewDeps(ws), { applicationId: B, revision: (await reviewDetail(ws, B)).revision, approvedReframingIds: [idOf(R3)] }, 'desktop')
      await application(B, { notes: notes(RUN_B, [R3], []), review: { runId: RUN_B, state: 'unreviewed', at: '2026-10-09T11:45:00.000Z' } })
      before = await approvalsOnDisk()
      expect(before).toContain(idOf(R3))
      changes = 0
      revision = (await get()).revision
    })
    afterEach(async () => {
      expect(await approvalsOnDisk()).toBe(before)
      expect((await getReview(ws, A))?.state).toBe('unreviewed')
      expect(changes).toBe(0)
    })

    it('a forged reframing id is invalid', async () => {
      const r = await send('review.approve', { applicationId: A, revision, approvedReframingIds: [idOf(R1), 'f'.repeat(64)] })
      expect(r.result.error?.code).toBe('invalid')
    })

    it('an id from another application is invalid', async () => {
      const b = await get(B)
      expect(b.proposedReframings.map((p) => p.id)).toEqual([idOf(R3)])
      const r = await send('review.approve', { applicationId: A, revision, approvedReframingIds: [idOf(R3)] })
      expect(r.result.error?.code).toBe('invalid')
    })

    it('a stale revision (notes edited after it was shown) is stale', async () => {
      await writeFile(join(ws, ...A.split('/'), 'review-notes.md'), notes(RUN, [R1, R2], ['Go: nothing honest to say'], 'Edited on the Mac.'))
      const r = await send('review.approve', { applicationId: A, revision, approvedReframingIds: [idOf(R1)] })
      expect(r.result.error?.code).toBe('stale')
    })

    it('a regenerated PDF is stale', async () => {
      await writeFile(join(ws, ...A.split('/'), 'resume.pdf'), '%PDF-1.4 rebuilt on the Mac')
      const r = await send('review.approve', { applicationId: A, revision, approvedReframingIds: [] })
      expect(r.result.error?.code).toBe('stale')
    })

    it("a revision never served to this phone is denied: a made-up one, the current one shown only to another phone, another result's", async () => {
      const current = (await reviewDetail(ws, A)).revision
      // A restart forgets what was served; then only the other phone fetches A, this one only B.
      gateway = new Gateway(services, devices)
      expect((await get(A, other)).revision).toBe(current)
      const b = await get(B)
      for (const revision of ['a'.repeat(64), current, b.revision]) {
        const r = await send('review.approve', { applicationId: A, revision, approvedReframingIds: [idOf(R1)] })
        expect(r.result.error?.code, revision).toBe('denied')
      }
      expect((await send('review.discard', { applicationId: A, revision: current })).result.error?.code).toBe('denied')
      expect((await send('review.rerun', { runId: RUN, revision: current, answers: 'Use R1.' })).result.error?.code).toBe('denied')
      expect(replies).toEqual([])
    })
  })
})

describe('review.rerun and review.discard (#42)', () => {
  it('re-run sends the answers to the result’s own run through the desktop’s reply path; the result is Unreviewed again', async () => {
    await application(A, { review: { state: 'needs-attention', reason: 'Failed checks: page_count.' } })
    const d = await get()
    expect((await send('review.rerun', { runId: 'wrong-run', revision: d.revision, answers: 'x' })).result.error?.code).toBe('denied')
    expect((await send('review.rerun', { runId: RUN, revision: d.revision, answers: '   ' })).result.error?.code).toBe('invalid')
    const reply = await send('review.rerun', { runId: RUN, revision: d.revision, answers: 'Drop the Kafka line.' })
    expect(reply.result.ok).toBe(true)
    expect(replies).toHaveLength(1)
    expect(replies[0].runId).toBe(RUN)
    expect(replies[0].text).toContain('Decisions: Drop the Kafka line.')
    expect(await getReview(ws, A)).toMatchObject({ state: 'unreviewed', reason: 'Re-running with your answers.', via: `phone:${phone.id}` })
    expect(changes).toBe(1)
    // A second decision on the same (now old) revision is stale.
    expect((await send('review.rerun', { runId: RUN, revision: d.revision, answers: 'Again.' })).result.error?.code).toBe('stale')
  })

  it('discard archives the result like the desktop and deletes no file', async () => {
    const folder = await application(A)
    const files = ['resume.pdf', 'cover.pdf', 'resume-page-1.jpg', 'cover-page-1.jpg', 'review-notes.md', 'build-report.json', 'job-description.md']
    const before = await Promise.all(files.map((f) => readFile(join(folder, f))))
    const d = await get()
    const reply = await send('review.discard', { applicationId: A, revision: d.revision })
    expect(reply.result.ok).toBe(true)
    expect(await getReview(ws, A)).toMatchObject({ state: 'discarded', via: `phone:${phone.id}` })
    const after = await Promise.all(files.map((f) => readFile(join(folder, f))))
    expect(after).toEqual(before)
    expect(JSON.parse(await readFile(join(folder, 'huntgry.json'), 'utf8')).status).toBe('archived')
    expect(await loadApprovals(ws)).toEqual([])
  })
})

describe('review.needed and the status (#42)', () => {
  it('announces a result newly waiting for review once, with needs-review; ones still being built are not announced', async () => {
    const sent: { name: RemoteEventName; body: unknown; pushText?: string; hint: unknown }[] = []
    const events = new RemoteEvents({
      broadcast: async (name, body, pushText, hint) => {
        requireEvent(name, body)
        sent.push({ name, body, pushText, hint })
      },
      status: () => statusOf(services, identity),
      reviews: async () => ({ workspaceId: identity.id, items: await pendingReviews(services, identity) }),
      reviewDelayMs: 0
    })
    await application(A)
    await events.checkReviews()
    expect(sent).toEqual([]) // the baseline
    await application(B, { review: { runId: RUN_B, at: '2026-10-09T11:50:00.000Z', reason: IN_PROGRESS_REASON } })
    await events.checkReviews()
    expect(sent.filter((e) => e.name === 'review.needed')).toEqual([])
    // The verify gate settles it.
    await updateReview(ws, B, (c) => ({ ...c!, reason: undefined, at: '2026-10-09T11:55:00.000Z' }))
    await events.handle('queue:changed', queueState())
    for (let i = 0; i < 100 && !sent.some((e) => e.name === 'review.needed'); i++) await new Promise((r) => setTimeout(r, 10))
    await events.checkReviews()
    const needed = sent.filter((e) => e.name === 'review.needed')
    expect(needed).toHaveLength(1)
    expect(needed[0]).toMatchObject({ body: { count: 2, latest: { applicationId: B, runId: RUN_B } }, pushText: 'Platform Engineer · Initech', hint: undefined })
    const status = sent.filter((e) => e.name === 'status').at(-1)!.body as { review: { unreviewed: number } }
    expect(status.review.unreviewed).toBe(2)
  })

  it('status.get counts the results waiting for review', async () => {
    await application(A)
    await application(B, { review: { runId: RUN_B, reason: IN_PROGRESS_REASON } })
    const status = (await send('status.get')).result.body as { review: { unreviewed: number } }
    expect(status.review.unreviewed).toBe(1)
  })

  it('answers unsupported without a review service', async () => {
    const plain = new Gateway({ ...services, review: undefined }, devices)
    phone.seq++
    const r = await plain.handle(devices.get(phone.id)!, command(phone, 'review.list', undefined, identity.id, { ts: new Date((now += 1000)).toISOString(), seq: phone.seq }))
    expect(r.result.error?.code).toBe('unsupported')
  })
})

// ── a reconnect does not forget what a phone was shown ─────────────────────────────────────

/** A one-socket fake relay: owner auth first, records the desktop's frames, delivers the phone's. */
class MiniRelay {
  sockets: MiniSocket[] = []
  sent: RelayFrame[] = []
  connect = (): SocketLike => {
    const s = new MiniSocket(this)
    this.sockets.push(s)
    queueMicrotask(() => s.emit('open'))
    return s
  }
  deliver(frame: RelayFrame): void {
    this.sockets.at(-1)!.emit('message', JSON.stringify(frame))
  }
  drop(): void {
    const s = this.sockets.at(-1)!
    s.closed = true
    s.emit('close', 'network')
  }
}

class MiniSocket implements SocketLike {
  private handlers = new Map<string, ((...a: never[]) => void)[]>()
  authed = false
  closed = false
  constructor(private relay: MiniRelay) {}
  send(text: string): void {
    if (this.closed) throw new Error('closed')
    const raw = JSON.parse(text)
    if (!this.authed) {
      this.authed = true
      return
    }
    if ('ct' in raw) this.relay.sent.push(requireRelayFrame(raw))
  }
  close(): void {
    this.closed = true
  }
  on(event: string, cb: (...a: never[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb])
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args)
  }
}

describe('served revisions across a reconnect (#42)', () => {
  it('a revision fetched before the relay dropped the Mac still approves after it reconnected', async () => {
    await application(A)
    services.now = undefined
    gateway = new Gateway(services, devices)
    const relay = new MiniRelay()
    const session = new RemoteSession({
      connect: relay.connect,
      devices,
      gateway,
      desktopName: 'Mac',
      appVersion: '0.1.0',
      workspace: async () => identity,
      status: () => statusOf(services, identity),
      notificationDetails: () => false,
      backoffMinMs: 10,
      backoffMaxMs: 20
    })
    const online = async () => {
      for (let i = 0; i < 200 && !session.isOnline(); i++) await new Promise((r) => setTimeout(r, 5))
      expect(session.isOnline()).toBe(true)
    }
    const roundTrip = async (env: Envelope): Promise<Envelope> => {
      relay.deliver({ to: 'desktop', ref: env.id!, ...sealEnvelope(env, phone.sessionKey), ttl: env.ttl })
      for (let i = 0; i < 400; i++) {
        for (const f of relay.sent) {
          const plain = openEnvelope(f, phone.sessionKey)
          if (plain && (plain as Envelope).re === env.id) return requireEnvelope(plain, { sid: phone.sid, from: 'desktop' })
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error('no result')
    }
    try {
      session.start({ relayUrl: 'https://relay.example.com', adminToken: 'a', roomId: 'room', ownerSecret: 'owner' })
      await online()
      const detail = (await roundTrip(command(phone, 'review.get', { applicationId: A }, identity.id))).body as ReviewDetail
      relay.drop()
      await online()
      expect(relay.sockets).toHaveLength(2)
      const approved = await roundTrip(command(phone, 'review.approve', { applicationId: A, revision: detail.revision, approvedReframingIds: [idOf(R2)] }, identity.id))
      expect(approved.ok).toBe(true)
      expect((await getReview(ws, A))?.state).toBe('approved')
      expect((await loadApprovals(ws)).map((a) => a.id)).toEqual([idOf(R2)])
    } finally {
      session.stop()
    }
  })
})
