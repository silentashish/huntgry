import { describe, expect, it } from 'vitest'
import type { ApplicationRecord, ApplicationTracking } from './applications-types'
import { BOARD_COLUMNS, buildBoard, moveFor, moveTargets, type Board, type BoardCard, type BoardColumnId } from './board'
import type { Job } from './jobs-types'
import type { QueueItem } from './queue-types'

const NOW = new Date('2026-10-07T12:00:00Z')

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id: `url:${id}`,
  source: 'url',
  sourceId: id,
  title: `Engineer ${id}`,
  company: 'Acme',
  location: 'Remote',
  remote: true,
  salary: '',
  postedAt: null,
  url: `https://jobs.example.com/${id}`,
  boardUrl: null,
  description: 'Go and PostgreSQL.',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-01T00:00:00.000Z',
  ...over
})

const app = (id: string, tracking: Partial<ApplicationTracking> = {}, over: Partial<ApplicationRecord> = {}): ApplicationRecord => ({
  id: `software-engineer/acme/${id}`,
  role: 'Software Engineer',
  company: 'Acme',
  jobId: id,
  jobTitle: `Engineer ${id}`,
  jobUrl: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  files: ['resume.pdf'],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  tracking: { status: 'generated', notes: '', ...tracking },
  ...over
})

const item = (id: string, jobId: string, status: QueueItem['status'], updatedAt = '2026-10-03T00:00:00.000Z'): QueueItem => ({
  id: `q-${id}`,
  jobId,
  title: `Queued ${id} · Acme`,
  options: { coverLetter: true, dateStyle: 'right' },
  agent: 'claude',
  status,
  runId: null,
  attempts: 0,
  createdAt: updatedAt,
  updatedAt
})

/** Card keys per column, empty columns left out. */
function layout(board: Board): Partial<Record<BoardColumnId, string[]>> {
  const out: Partial<Record<BoardColumnId, string[]>> = {}
  for (const c of board.columns) if (c.cards.length) out[c.id] = c.cards.map((k) => k.key)
  return out
}

const card = (board: Board, key: string): BoardCard => board.columns.flatMap((c) => c.cards).find((c) => c.key === key)!

describe('buildBoard', () => {
  it('has every column in board order, empty when there is nothing', () => {
    const board = buildBoard({ jobs: [], applications: [], queue: [], now: NOW })
    expect(board.columns.map((c) => c.id)).toEqual(BOARD_COLUMNS)
    expect(board.columns.map((c) => c.label)).toEqual([
      'To do',
      'Tailoring',
      'Needs review',
      'Ready to submit',
      'Ready to apply',
      'Applied',
      'Interviewing',
      'Offer',
      'Rejected',
      'Archived'
    ])
    expect(board.hiddenArchived).toBe(0)
  })

  it('puts saved jobs, queue items and applications in their columns', () => {
    const board = buildBoard({
      jobs: [job('a'), job('b'), job('c'), job('d', { dismissed: true, dismissedAt: '2026-10-06T00:00:00.000Z' })],
      queue: [item('b', 'url:b', 'running'), item('c', 'url:c', 'needs-reply'), item('x', 'url:gone', 'failed')],
      applications: [
        app('r1'),
        app('r2', { review: { state: 'unreviewed', runId: 'r', at: '2026-10-04T00:00:00.000Z' } }),
        app('r3', { review: { state: 'approved', runId: 'r', at: '2026-10-04T00:00:00.000Z' } }),
        app('p1', { status: 'applied', appliedAt: '2026-10-05' }),
        app('i1', { status: 'interviewing' }),
        app('o1', { status: 'offer' }),
        app('n1', { status: 'rejected' }),
        app('z1', { status: 'archived', archivedAt: '2026-10-05T00:00:00.000Z' })
      ],
      now: NOW
    })
    expect(layout(board)).toEqual({
      todo: ['job:url:a'],
      tailoring: ['queue:q-b', 'queue:q-x'],
      review: ['queue:q-c', 'app:software-engineer/acme/r2'],
      ready: ['app:software-engineer/acme/r1', 'app:software-engineer/acme/r3'],
      applied: ['app:software-engineer/acme/p1'],
      interviewing: ['app:software-engineer/acme/i1'],
      offer: ['app:software-engineer/acme/o1'],
      rejected: ['app:software-engineer/acme/n1'],
      archived: ['job:url:d', 'app:software-engineer/acme/z1']
    })
    // A queue item whose job is no longer saved keeps the title it was queued with.
    expect(card(board, 'queue:q-x')).toMatchObject({ title: 'Queued x', subtitle: 'Acme' })
    expect(card(board, 'queue:q-b')).toMatchObject({ title: 'Engineer b', subtitle: 'Acme · Remote' })
  })

  it('shows one card per job: the furthest stage wins', () => {
    const jobs = [job('a'), job('b'), job('c'), job('d'), job('e')]
    const board = buildBoard({
      jobs,
      queue: [
        // A working item beats a generated application (a re-run), …
        item('a', 'url:a', 'running'),
        // … but not one the user already applied with.
        item('b', 'url:b', 'needs-reply'),
        // A failed item gives way to the application it left behind.
        item('c', 'url:c', 'failed'),
        // Done items hand the card back to the application.
        item('d', 'url:d', 'done')
      ],
      applications: [
        // Matched by posting URL …
        app('a1', {}, { jobUrl: 'https://jobs.example.com/a' }),
        app('b1', { status: 'applied' }, { jobUrl: 'https://jobs.example.com/b' }),
        // … or by the folder's job id and the company.
        app('c', {}, { company: 'ACME' }),
        app('d', {}),
        // Same job id, another company: not the saved job's application.
        app('e', {}, { id: 'eng/globex/e', company: 'Globex' })
      ],
      now: NOW
    })
    expect(layout(board)).toEqual({
      todo: ['job:url:e'],
      tailoring: ['queue:q-a'],
      ready: ['app:eng/globex/e', 'app:software-engineer/acme/c', 'app:software-engineer/acme/d'],
      applied: ['app:software-engineer/acme/b1']
    })
    const all = board.columns.flatMap((c) => c.cards)
    expect(new Set(all.map((c) => c.key)).size).toBe(all.length)
    expect(card(board, 'app:software-engineer/acme/c')).toMatchObject({ job: { id: 'url:c' } })
  })

  it("keeps the application a working queue item supersedes on the queue card, so it stays reachable (#161)", () => {
    const board = buildBoard({
      jobs: [job('a'), job('b')],
      queue: [item('a', 'url:a', 'running'), item('b', 'url:b', 'queued')],
      applications: [app('a1', { notes: 'Recruiter: Dana' }, { jobUrl: 'https://jobs.example.com/a' })],
      now: NOW
    })
    expect(layout(board)).toEqual({ tailoring: ['queue:q-a', 'queue:q-b'] })
    expect(card(board, 'queue:q-a')).toMatchObject({ kind: 'queue', app: { id: 'software-engineer/acme/a1' } })
    // A queue item with no application behind it has none.
    expect(card(board, 'queue:q-b')).toMatchObject({ kind: 'queue', app: null })
  })

  it('finds the queue item of a job through its aliases and prefers a working item over a failed one', () => {
    const board = buildBoard({
      jobs: [job('a', { aliases: ['indeed:a'] })],
      queue: [item('old', 'url:a', 'failed', '2026-10-05T00:00:00.000Z'), item('new', 'indeed:a', 'queued', '2026-10-04T00:00:00.000Z')],
      applications: [],
      now: NOW
    })
    expect(layout(board)).toEqual({ tailoring: ['queue:q-new'] })
  })

  it('keeps archived cards for a week from when they were archived, then leaves them off', () => {
    const archived = (days: number, hours = 0) =>
      new Date(NOW.getTime() - ((days * 24 + hours) * 60 + 0) * 60 * 1000).toISOString()
    const board = buildBoard({
      jobs: [
        job('j-fresh', { dismissed: true, dismissedAt: archived(6, 23) }),
        job('j-stale', { dismissed: true, dismissedAt: archived(7) }),
        // Dismissed before #85: no time, so the time it was saved counts.
        job('j-legacy', { dismissed: true, fetchedAt: '2026-09-01T00:00:00.000Z' })
      ],
      queue: [],
      applications: [
        app('fresh', { status: 'archived', archivedAt: archived(1) }, { updatedAt: '2026-01-01T00:00:00.000Z' }),
        app('stale', { status: 'archived', archivedAt: archived(8) }, { updatedAt: NOW.toISOString() }),
        app('legacy', { status: 'archived' }, { updatedAt: archived(2) }),
        app('discarded', {
          review: { state: 'discarded', runId: 'r', at: archived(10), reviewedAt: archived(3) }
        })
      ],
      now: NOW
    })
    expect(layout(board)).toEqual({
      archived: [
        'app:software-engineer/acme/fresh',
        'app:software-engineer/acme/legacy',
        'app:software-engineer/acme/discarded',
        'job:url:j-fresh'
      ]
    })
    expect(board.hiddenArchived).toBe(3)
    // An archived card is dated by when it was archived.
    expect(card(board, 'app:software-engineer/acme/fresh').at).toBe(archived(1))
  })

  it('keeps every archived card, however old, with keepArchived (#161: what the Dashboard table listed)', () => {
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
    const input = {
      jobs: [job('j-stale', { dismissed: true, dismissedAt: daysAgo(30) })],
      queue: [],
      applications: [
        app('fresh', { status: 'archived' as const, archivedAt: daysAgo(1) }),
        app('stale', { status: 'archived' as const, archivedAt: daysAgo(90) })
      ],
      now: NOW
    }
    expect(buildBoard(input).hiddenArchived).toBe(2)
    const all = buildBoard({ ...input, keepArchived: true })
    expect(all.hiddenArchived).toBe(0)
    expect(layout(all)).toEqual({
      archived: ['app:software-engineer/acme/fresh', 'job:url:j-stale', 'app:software-engineer/acme/stale']
    })
    // Dated by when they were archived, like the recent ones.
    expect(card(all, 'app:software-engineer/acme/stale').at).toBe(daysAgo(90))
  })
})

describe('moveFor', () => {
  const board = buildBoard({
    jobs: [job('t'), job('z', { dismissed: true, dismissedAt: '2026-10-06T00:00:00.000Z' }), job('q')],
    queue: [item('q', 'url:q', 'running')],
    applications: [
      app('r'),
      app('u', { review: { state: 'unreviewed', runId: 'r', at: '2026-10-04T00:00:00.000Z' } }),
      app('d', { review: { state: 'discarded', runId: 'r', at: '2026-10-04T00:00:00.000Z' } }),
      app('p', { status: 'applied' })
    ],
    now: NOW
  })

  it('archives and restores a saved job, and nothing else', () => {
    expect(moveFor(card(board, 'job:url:t'), 'archived')).toEqual({ kind: 'job', id: 'url:t', patch: { dismissed: true } })
    expect(moveFor(card(board, 'job:url:z'), 'todo')).toEqual({ kind: 'job', id: 'url:z', patch: { dismissed: false } })
    expect(moveTargets(card(board, 'job:url:t'))).toEqual(['archived'])
    expect(moveTargets(card(board, 'job:url:z'))).toEqual(['todo'])
  })

  it('moves an application between status columns, never into Tailoring or Needs review', () => {
    const ready = card(board, 'app:software-engineer/acme/r')
    expect(moveFor(ready, 'applied')).toEqual({
      kind: 'application',
      id: 'software-engineer/acme/r',
      patch: { status: 'applied' }
    })
    expect(moveTargets(ready)).toEqual(['applied', 'interviewing', 'offer', 'rejected', 'archived'])
    expect(moveTargets(card(board, 'app:software-engineer/acme/p'))).toEqual([
      'ready',
      'interviewing',
      'offer',
      'rejected',
      'archived'
    ])
    expect(moveFor(card(board, 'app:software-engineer/acme/p'), 'ready')?.patch).toEqual({ status: 'generated' })
  })

  it('lets a result waiting for review only be archived or rejected; a discarded one and a queue card stay put', () => {
    expect(moveTargets(card(board, 'app:software-engineer/acme/u'))).toEqual(['rejected', 'archived'])
    expect(moveTargets(card(board, 'app:software-engineer/acme/d'))).toEqual([])
    expect(moveTargets(card(board, 'queue:q-q'))).toEqual([])
    expect(moveFor(card(board, 'app:software-engineer/acme/r'), 'ready')).toBeNull()
  })
})

describe('Ready to submit (#154)', () => {
  const unreviewed = { review: { state: 'unreviewed' as const, runId: 'r', at: '2026-10-04T00:00:00.000Z' } }
  const board = buildBoard({
    jobs: [],
    queue: [],
    applications: [
      app('s', unreviewed),
      app('a', { status: 'applied' }),
      app('x', { review: { state: 'discarded', runId: 'r', at: '2026-10-04T00:00:00.000Z' } }),
      app('n', unreviewed)
    ],
    readyToSubmit: new Set(['software-engineer/acme/s', 'software-engineer/acme/a', 'software-engineer/acme/x']),
    now: NOW
  })

  it('puts a prepared application in Ready to submit while it is generated, not once applied or discarded', () => {
    expect(layout(board)).toEqual({
      submit: ['app:software-engineer/acme/s'],
      review: ['app:software-engineer/acme/n'],
      applied: ['app:software-engineer/acme/a'],
      archived: ['app:software-engineer/acme/x']
    })
  })

  it('takes no drops, and its cards can only be archived or rejected', () => {
    expect(moveTargets(card(board, 'app:software-engineer/acme/s'))).toEqual(['rejected', 'archived'])
    expect(moveFor(card(board, 'app:software-engineer/acme/a'), 'submit')).toBeNull()
    expect(moveTargets(card(board, 'app:software-engineer/acme/a'))).not.toContain('submit')
  })
})
