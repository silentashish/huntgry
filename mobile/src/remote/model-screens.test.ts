/**
 * The #40 / #41 / #42 flows of the model against the fake WebSocket and a fake desktop holding
 * the fixture session key: what the phone sends, and what it does with each answer.
 */

import { LIMITS, type Envelope, type PipelineState, type RemoteJob, type ReviewDetail } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { chunksOf, fileKey, sha256Hex } from './files'
import { RemoteModel } from './model'
import { REVIEW_COPY } from './review'
import { FakeClock, FakeDesktop, STATUS, Sockets, pairedVault, presence, settle } from './test-helpers'

const APP = 'em-platform/figma/url-0123456789abcdef'

async function connected() {
  const clock = new FakeClock()
  const sockets = new Sockets()
  const { vault, storage } = await pairedVault()
  const model = new RemoteModel({ vault, socket: sockets.factory, clock, appVersion: '0.1.0', deviceName: 'iPhone', random: () => 0.5 })
  await model.init()
  const desktop = new FakeDesktop(clock)
  sockets.last.open()
  sockets.last.receive(presence())
  await settle()
  sockets.last.receive(desktop.event('status', STATUS))
  await settle()
  const sent = (name: string): Envelope[] => sockets.last.envelopes().filter((e) => e.name === name)
  const last = (name: string): Envelope => sent(name).at(-1)!
  const answer = async (env: Envelope, body: unknown) => {
    sockets.last.receive(desktop.result(env.id!, body))
    await settle()
  }
  const refuse = async (env: Envelope, code: NonNullable<Envelope['error']>['code'], message: string) => {
    sockets.last.receive(desktop.result(env.id!, null, { ok: false, error: { code, message } }))
    await settle()
  }
  return { clock, sockets, model, desktop, storage, sent, last, answer, refuse }
}

const job = (i: number, over: Partial<RemoteJob> = {}): RemoteJob => ({ id: `url:${String(i).padStart(16, '0')}`, title: `Engineer ${i}`, company: 'Acme', savedAt: '2026-10-01T10:00:00.000Z', ...over })

function page(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * seed + 3) & 0xff
  return out
}

const RESUME_P1 = page(30_000, 5)
const COVER_P1 = page(10_000, 11)

const DETAIL: ReviewDetail = {
  applicationId: APP,
  runId: 'run-figma',
  title: 'EM, Platform · Figma',
  reviewNotes: '## Gaps',
  openGaps: ['gRPC'],
  proposedReframings: [
    { id: '1'.repeat(64), sourceFact: 'Managed a platform team of 6+', wording: 'Led a 4-person platform team' },
    { id: '2'.repeat(64), sourceFact: 'Owned on-call', wording: 'Owned the on-call rotation' }
  ],
  verify: { ok: true, report: 'pass' },
  artifacts: [
    { file: 'resume.pdf', bytes: 60_000, sha256: 'a'.repeat(64) },
    { file: 'resume-page-1.jpg', bytes: RESUME_P1.length, sha256: sha256Hex(RESUME_P1) },
    { file: 'cover-page-1.jpg', bytes: COVER_P1.length, sha256: sha256Hex(COVER_P1) }
  ],
  revision: '9'.repeat(64),
  state: 'unreviewed'
}

/** Answers every outstanding file.get for `file` from `data` until it is complete. */
async function serveFile(t: Awaited<ReturnType<typeof connected>>, file: 'resume-page-1.jpg' | 'cover-page-1.jpg', data: Uint8Array) {
  const chunks = chunksOf(APP, file, data)
  for (const c of chunks) {
    const req = t.sent('file.get').find((e) => (e.body as { file: string; chunk: number }).file === file && (e.body as { chunk: number }).chunk === c.chunk)
    expect(req, `file.get ${file} #${c.chunk}`).toBeDefined()
    await t.answer(req!, c)
  }
}

describe('jobs (#40)', () => {
  it('pages jobs.list by cursor, keeps dismissed jobs flagged and drops a page for an old search', async () => {
    const t = await connected()
    t.model.loadJobs()
    await settle()
    const first = t.last('jobs.list')
    expect(first).toMatchObject({ ws: STATUS.desktop.workspaceId, body: {} })
    await t.answer(first, { items: Array.from({ length: 50 }, (_, i) => job(i, { dismissed: i === 3 })), nextCursor: 'c-50' })
    expect(t.model.getSnapshot().jobs).toMatchObject({ loading: false, nextCursor: 'c-50' })
    expect(t.model.getSnapshot().jobs!.items[3].dismissed).toBe(true)

    t.model.loadJobs(undefined, true)
    await settle()
    expect(t.last('jobs.list').body).toEqual({ cursor: 'c-50' })
    await t.answer(t.last('jobs.list'), { items: [job(50), job(51)] })
    expect(t.model.getSnapshot().jobs!.items).toHaveLength(52)
    expect(t.model.getSnapshot().jobs!.nextCursor).toBeUndefined()

    t.model.loadJobs('stripe')
    await settle()
    const search = t.last('jobs.list')
    expect(search.body).toEqual({ filter: 'stripe' })
    t.model.loadJobs('notion')
    await settle()
    await t.answer(search, { items: [job(1, { company: 'Stripe' })] })
    expect(t.model.getSnapshot().jobs).toMatchObject({ filter: 'notion', items: [], loading: true })
  })

  it('adds a job by URL; a private or non-http link never leaves the phone', async () => {
    const t = await connected()
    t.model.loadJobs()
    await settle()
    await t.answer(t.last('jobs.list'), { items: [job(1)] })
    for (const bad of ['ftp://jobs.example.com/1', 'http://localhost:3000/job', 'http://192.168.1.10/job', 'https://user:pw@jobs.example.com/1', 'not a url']) {
      expect(t.model.addJobUrl(bad)).toBe(false)
    }
    await settle()
    expect(t.sent('jobs.addUrl')).toHaveLength(0)
    expect(t.model.getSnapshot().toast?.text).toMatch(/link/)

    expect(t.model.addJobUrl('  https://jobs.example.com/postings/42  ')).toBe(true)
    await settle()
    const add = t.last('jobs.addUrl')
    expect(add.body).toEqual({ url: 'https://jobs.example.com/postings/42' })
    await t.answer(add, job(42, { title: 'Staff Engineer' }))
    expect(t.model.getSnapshot().jobs!.items.map((j) => j.title)).toEqual(['Staff Engineer', 'Engineer 1'])
    // The desktop's own refusal (DNS resolves to a private address) is shown as it says it.
    t.model.addJobUrl('https://intranet-alias.example.com/1')
    await settle()
    await t.refuse(t.last('jobs.addUrl'), 'invalid', 'That address resolves to a private network.')
    expect(t.model.getSnapshot().toast?.text).toBe('That address resolves to a private network.')
  })

  it('queues selected jobs with queue.enqueue', async () => {
    const t = await connected()
    t.model.enqueueJobs([job(1).id, job(2).id])
    await settle()
    const enq = t.last('queue.enqueue')
    expect(enq).toMatchObject({ ttl: 7200, body: { jobIds: [job(1).id, job(2).id], options: { coverLetter: true, dateStyle: 'right' } } })
    await t.answer(enq, { added: 2, skipped: [], queue: { items: [], concurrency: 2, paused: false } })
    expect(t.model.getSnapshot().toast?.text).toBe('Queued 2 jobs.')
  })
})

describe('files (#40)', () => {
  it('fetches chunk after chunk, reassembles, checks the hash and keeps the file in memory only', async () => {
    const t = await connected()
    const data = page(60_000, 7)
    t.model.fetchFile(APP, 'resume.pdf')
    await settle()
    const key = fileKey(APP, 'resume.pdf')
    const chunks = chunksOf(APP, 'resume.pdf', data)
    for (const c of chunks) {
      const req = t.last('file.get')
      expect(req.body).toEqual({ applicationId: APP, file: 'resume.pdf', chunk: c.chunk })
      expect(req.ttl).toBe(86_400)
      await t.answer(req, c)
    }
    expect(t.sent('file.get')).toHaveLength(3)
    const view = t.model.getSnapshot().files[key]
    expect(view).toMatchObject({ state: 'ready', received: 3, of: 3, bytes: 60_000, sha256: sha256Hex(data) })
    expect(view.data).toEqual(data)
    expect([...t.storage.data.values()].join('')).not.toContain(chunks[0].data.slice(0, 40))
    // Already held: not fetched again.
    t.model.fetchFile(APP, 'resume.pdf')
    await settle()
    expect(t.sent('file.get')).toHaveLength(3)
  })

  it('rejects a reassembled file whose hash differs and drops its bytes', async () => {
    const t = await connected()
    t.model.fetchFile(APP, 'resume.pdf')
    await settle()
    const good = chunksOf(APP, 'resume.pdf', page(30_000, 7))
    const evil = chunksOf(APP, 'resume.pdf', page(30_000, 8))
    await t.answer(t.last('file.get'), good[0])
    await t.answer(t.last('file.get'), { ...good[1], data: evil[1].data })
    const view = t.model.getSnapshot().files[fileKey(APP, 'resume.pdf')]
    expect(view).toMatchObject({ state: 'failed', error: expect.stringMatching(/checksum/) })
    expect(view.data).toBeUndefined()
  })

  it('a file.get the relay expired fails the download instead of hanging', async () => {
    const t = await connected()
    t.model.fetchFile(APP, 'cover.pdf')
    await settle()
    t.sockets.last.receive({ expired: true, ref: t.last('file.get').id })
    await settle()
    expect(t.model.getSnapshot().files[fileKey(APP, 'cover.pdf')].state).toBe('failed')
  })

  it('paces chunks under the desktop read limit and resumes after a rate-limited refusal', async () => {
    const t = await connected()
    const data = page(40 * LIMITS.fileChunkBytes, 3)
    const chunks = chunksOf(APP, 'resume.pdf', data)
    const key = fileKey(APP, 'resume.pdf')
    t.model.fetchFile(APP, 'resume.pdf')
    await settle()
    for (let i = 0; i < 24; i++) await t.answer(t.last('file.get'), chunks[i])
    // 24 chunks in the minute (the desktop allows 30 reads): the next waits for the minute to pass.
    expect(t.sent('file.get')).toHaveLength(24)
    expect(t.model.getSnapshot().files[key]).toMatchObject({ state: 'loading', received: 24, of: 40 })
    await t.clock.advance(60_000)
    expect(t.sent('file.get')).toHaveLength(25)
    // Other reads used up the Mac's minute: the chunk is asked for again later, nothing is lost.
    await t.refuse(t.last('file.get'), 'rate-limited', 'At most 30 reads per minute.')
    expect(t.model.getSnapshot().files[key]).toMatchObject({ state: 'loading', received: 24 })
    await t.clock.advance(10_000)
    expect(t.sent('file.get')).toHaveLength(26)
    expect(t.last('file.get').body).toEqual({ applicationId: APP, file: 'resume.pdf', chunk: 24 })
    for (let i = 24; i < 40; i++) await t.answer(t.last('file.get'), chunks[i])
    const view = t.model.getSnapshot().files[key]
    expect(view).toMatchObject({ state: 'ready', received: 40, sha256: sha256Hex(data) })
    // A hash, not toEqual: a deep compare of the 960 KB array alone takes seconds.
    expect(view.data && sha256Hex(view.data)).toBe(sha256Hex(data))
  })
})

describe('review (#42)', () => {
  async function opened() {
    const t = await connected()
    t.model.loadReviews()
    t.model.openReview(APP)
    await settle()
    await t.answer(t.last('review.list'), { items: [{ applicationId: APP, runId: 'run-figma', title: DETAIL.title, openGaps: 1, finishedAt: '2026-10-09T11:00:00.000Z', state: 'unreviewed' }] })
    await t.answer(t.last('review.get'), DETAIL)
    return t
  }

  it('review.get fetches the page-1 previews against the hashes of that revision', async () => {
    const t = await opened()
    expect(t.model.getSnapshot().reviews?.items).toHaveLength(1)
    expect(t.model.getSnapshot().review[APP].detail?.revision).toBe(DETAIL.revision)
    // One download at a time: resume page 1 first.
    expect(t.sent('file.get').map((e) => e.body)).toEqual([{ applicationId: APP, file: 'resume-page-1.jpg', chunk: 0 }])
    await serveFile(t, 'resume-page-1.jpg', RESUME_P1)
    await serveFile(t, 'cover-page-1.jpg', COVER_P1)
    expect(t.model.verifiedSha(APP, 'resume-page-1.jpg')).toBe(sha256Hex(RESUME_P1))
    expect(t.model.verifiedSha(APP, 'cover-page-1.jpg')).toBe(sha256Hex(COVER_P1))
  })

  it('a preview that is not the one the revision listed never counts', async () => {
    const t = await opened()
    // The first chunk already carries another hash: refused before the rest is asked for.
    await t.answer(t.last('file.get'), chunksOf(APP, 'resume-page-1.jpg', page(30_000, 99))[0])
    expect(t.sent('file.get').filter((e) => (e.body as { file: string }).file === 'resume-page-1.jpg')).toHaveLength(1)
    expect(t.model.getSnapshot().files[fileKey(APP, 'resume-page-1.jpg')]).toMatchObject({ state: 'failed', error: expect.stringMatching(/not the one/) })
    expect(t.model.verifiedSha(APP, 'resume-page-1.jpg')).toBeNull()
  })

  it('a refreshed revision replaces previews still loading, so Approve waits on the new hashes', async () => {
    const t = await opened()
    const oldReq = t.last('file.get')
    const R2 = page(30_000, 13)
    const C2 = page(10_000, 17)
    const next: ReviewDetail = {
      ...DETAIL,
      revision: '6'.repeat(64),
      artifacts: [DETAIL.artifacts[0], { file: 'resume-page-1.jpg', bytes: R2.length, sha256: sha256Hex(R2) }, { file: 'cover-page-1.jpg', bytes: C2.length, sha256: sha256Hex(C2) }]
    }
    t.sockets.last.receive(t.desktop.event('applications.changed', { ids: [APP] }))
    await settle()
    await t.answer(t.last('review.get'), next)
    const asked = (file: string) => t.sent('file.get').filter((e) => (e.body as { file: string }).file === file)
    expect(asked('resume-page-1.jpg')).toHaveLength(2)
    expect(t.model.getSnapshot().files[fileKey(APP, 'resume-page-1.jpg')]).toMatchObject({ state: 'waiting', expected: sha256Hex(R2) })
    // The old revision's chunk arrives late: ignored, the new download goes on.
    await t.answer(oldReq, chunksOf(APP, 'resume-page-1.jpg', RESUME_P1)[0])
    expect(t.model.getSnapshot().files[fileKey(APP, 'resume-page-1.jpg')]).toMatchObject({ state: 'waiting', expected: sha256Hex(R2) })
    for (const c of chunksOf(APP, 'resume-page-1.jpg', R2)) await t.answer(t.last('file.get'), c)
    for (const c of chunksOf(APP, 'cover-page-1.jpg', C2)) await t.answer(t.last('file.get'), c)
    expect(asked('cover-page-1.jpg')).toHaveLength(1)
    expect(t.model.verifiedSha(APP, 'resume-page-1.jpg')).toBe(sha256Hex(R2))
    expect(t.model.verifiedSha(APP, 'cover-page-1.jpg')).toBe(sha256Hex(C2))
  })

  it('approve sends the served revision and only the ticked ids that detail listed', async () => {
    const t = await opened()
    expect(t.model.approve(APP, ['2'.repeat(64), 'f'.repeat(64)])).toBe(true)
    await settle()
    const approve = t.last('review.approve')
    expect(approve).toMatchObject({ ttl: 7200, body: { applicationId: APP, revision: DETAIL.revision, approvedReframingIds: ['2'.repeat(64)] } })
    expect(t.model.getSnapshot().review[APP].deciding).toBe('approve')
    // A second press while the first is out does nothing.
    expect(t.model.approve(APP, [])).toBe(false)
    await t.answer(approve, { ...DETAIL, state: 'approved', revision: '8'.repeat(64) })
    expect(t.model.getSnapshot().review[APP]).toMatchObject({ deciding: undefined, detail: { state: 'approved' } })
    expect(t.model.getSnapshot().toast?.text).toBe(REVIEW_COPY.approved)
    expect(t.sent('review.list')).toHaveLength(2)
  })

  it('stale: the detail is fetched again and the owner is told; the pairing stays', async () => {
    const t = await opened()
    t.model.discard(APP)
    await settle()
    await t.refuse(t.last('review.discard'), 'stale', 'This result changed since you opened it.')
    expect(t.sent('review.get')).toHaveLength(2)
    expect(t.model.getSnapshot().review[APP]).toMatchObject({ notice: REVIEW_COPY.stale, deciding: undefined, loading: true })
    await t.answer(t.last('review.get'), { ...DETAIL, revision: '7'.repeat(64) })
    expect(t.model.getSnapshot().review[APP]).toMatchObject({ notice: REVIEW_COPY.stale, detail: { revision: '7'.repeat(64) } })
    expect(t.model.getSnapshot().phase).toBe('paired')
  })

  it('denied on a review means "open it again", not pair again', async () => {
    const t = await opened()
    t.model.rerun(APP, 'Use R1, drop R2.')
    await settle()
    const rerun = t.last('review.rerun')
    expect(rerun.body).toEqual({ runId: 'run-figma', revision: DETAIL.revision, answers: 'Use R1, drop R2.' })
    await t.refuse(rerun, 'denied', 'Open this result again before you decide.')
    const snap = t.model.getSnapshot()
    expect(snap.phase).toBe('paired')
    expect(snap.pairAgain).toBeNull()
    expect(t.storage.data.size).toBeGreaterThan(0)
    expect(snap.review[APP].notice).toBe(REVIEW_COPY.denied)
    expect(t.sent('review.get')).toHaveLength(2)
  })

  it('invalid (an id the Mac did not list) shows the Mac’s message and keeps the detail', async () => {
    const t = await opened()
    t.model.approve(APP, ['1'.repeat(64)])
    await settle()
    await t.refuse(t.last('review.approve'), 'invalid', 'A reframing is not part of this result.')
    expect(t.model.getSnapshot().toast?.text).toBe('A reframing is not part of this result.')
    expect(t.model.getSnapshot().review[APP].detail?.revision).toBe(DETAIL.revision)
    expect(t.sent('review.get')).toHaveLength(1)
  })

  it('applications.changed refreshes the list and the open result, and says when its revision changed', async () => {
    const t = await opened()
    t.sockets.last.receive(t.desktop.event('applications.changed', { ids: [] }))
    await settle()
    expect(t.sent('review.list')).toHaveLength(2)
    expect(t.sent('review.get')).toHaveLength(2)
    await t.answer(t.last('review.get'), { ...DETAIL, revision: '6'.repeat(64) })
    expect(t.model.getSnapshot().review[APP].notice).toBe(REVIEW_COPY.changed)
    // Its Files screen keeps watching it; a closed result is not fetched again.
    t.model.closeReview(APP)
    t.model.watchReview(APP)
    t.sockets.last.receive(t.desktop.event('applications.changed', { ids: [] }))
    await settle()
    expect(t.sent('review.get')).toHaveLength(3)
    await t.answer(t.last('review.get'), { ...DETAIL, revision: '6'.repeat(64) })
    t.model.closeReview(APP)
    t.sockets.last.receive(t.desktop.event('applications.changed', { ids: [] }))
    await settle()
    expect(t.sent('review.get')).toHaveLength(3)
  })

  it('review.needed refreshes the list', async () => {
    const t = await opened()
    t.sockets.last.receive(t.desktop.event('review.needed', { count: 2, latest: { applicationId: APP, runId: 'run-figma', title: DETAIL.title, openGaps: 0, finishedAt: '2026-10-09T11:00:00.000Z' } }))
    await settle()
    expect(t.sent('review.list')).toHaveLength(2)
  })
})

describe('pipeline (#41)', () => {
  const STATE: PipelineState = { status: 'running', agent: 'claude', counts: { total: 3, done: 0, running: 2, queued: 1, failed: 0, unreviewed: 0 }, startedAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z' }

  it('starts with the costly TTL, then follows pipeline.changed and pipeline.finished', async () => {
    const t = await connected()
    expect(t.model.startPipeline({ jobIds: [job(1).id, job(2).id, job(3).id], concurrency: 2, agent: 'claude', fallback: 'codex' })).toBe(true)
    await settle()
    const start = t.last('pipeline.start')
    expect(start).toMatchObject({ ttl: 7200, ws: STATUS.desktop.workspaceId, body: { jobIds: [job(1).id, job(2).id, job(3).id], concurrency: 2, agent: 'claude', fallback: 'codex' } })
    expect(t.model.getSnapshot().commands[0]).toMatchObject({ label: 'Start pipeline · 3 jobs' })
    await t.answer(start, STATE)
    expect(t.model.getSnapshot().pipeline).toEqual(STATE)

    const limit = { ...STATE, status: 'waiting-limit' as const, waitingLimitUntil: '2026-10-09T14:05:00.000Z', reason: 'Claude usage limit reached.' }
    t.sockets.last.receive(t.desktop.event('pipeline.changed', limit))
    await settle()
    expect(t.model.getSnapshot().pipeline).toMatchObject({ status: 'waiting-limit', waitingLimitUntil: '2026-10-09T14:05:00.000Z' })

    t.model.pipelinePause()
    await settle()
    await t.answer(t.last('pipeline.pause'), { ...STATE, status: 'paused' })
    expect(t.model.getSnapshot().pipeline?.status).toBe('paused')

    const summary = { status: 'finished', counts: { ...STATE.counts, done: 3, running: 0, queued: 0, unreviewed: 3 }, costUsd: 1.2, startedAt: STATE.startedAt, finishedAt: '2026-10-09T13:00:00.000Z' }
    t.sockets.last.receive(t.desktop.event('pipeline.finished', summary))
    await settle()
    expect(t.model.getSnapshot()).toMatchObject({ pipeline: null, lastPipeline: { status: 'finished' } })
  })

  it('a desktop refusal (pre-flight, already running) is shown as the Mac says it', async () => {
    const t = await connected()
    t.model.startPipeline({ jobIds: [job(1).id], concurrency: 1, agent: 'codex' })
    await settle()
    await t.refuse(t.last('pipeline.start'), 'failed', 'A pipeline is already running in this workspace.')
    expect(t.model.getSnapshot().toast?.text).toBe('A pipeline is already running in this workspace.')
    expect(t.model.getSnapshot().pipeline).toBeNull()
  })
})
