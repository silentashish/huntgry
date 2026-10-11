import { describe, expect, it } from 'vitest'
import type { ApplicationRecord } from '@shared/applications-types'
import { buildBoard, type BoardCard } from '@shared/board'
import { profileSignals, scoreJob, type ProfileSignals } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import type { QueueItem } from '@shared/queue-types'
import { ago, cardMeta, cardPills, cardScent, companyOf, span } from './card'

const NOW = new Date('2026-10-07T12:00:00Z')

const job: Job = {
  id: 'url:a',
  source: 'url',
  sourceId: 'a',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  salary: '',
  postedAt: '2026-10-06T08:00:00.000Z',
  url: 'https://jobs.example.com/a',
  boardUrl: null,
  description: 'Go and Postgres. We sponsor H-1B visas.',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-06T09:00:00.000Z'
}

const app = (over: Partial<ApplicationRecord> = {}, tracking: Partial<ApplicationRecord['tracking']> = {}): ApplicationRecord => ({
  id: 'software-engineer/globex/g-1',
  role: 'Software Engineer',
  company: 'Globex',
  jobId: 'g-1',
  jobTitle: 'Platform Engineer',
  jobUrl: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  files: ['resume.pdf', 'cover.pdf'],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  ...over,
  tracking: { status: 'generated', notes: '', ...tracking }
})

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 'q-1',
  jobId: 'url:gone',
  title: 'Backend Engineer · Initech',
  options: { coverLetter: true, dateStyle: 'right' },
  agent: 'codex',
  status: 'running',
  runId: '20261007-110000-aaaaaa',
  attempts: 1,
  createdAt: '2026-10-07T11:00:00.000Z',
  updatedAt: '2026-10-07T11:46:00.000Z',
  ...over
})

const only = (input: Partial<Parameters<typeof buildBoard>[0]>): BoardCard => {
  const cards = buildBoard({ jobs: [], applications: [], queue: [], now: NOW, ...input }).columns.flatMap((c) => c.cards)
  expect(cards).toHaveLength(1)
  return cards[0]
}

const signals: ProfileSignals = {
  titles: ['Backend Engineer'],
  skills: ['Go', 'Postgres'],
  location: '',
  remote: true,
  needsSponsorship: false,
  years: 6
}

describe('cardScent', () => {
  it('is the job relevance score (0–100) when the card has a job and the profile has signals', () => {
    const card = only({ jobs: [job] })
    const scent = cardScent(card, signals, NOW)
    expect(scent).toEqual({ mode: 'score', value: scoreJob(job, signals, NOW).score, reasons: expect.any(Array) })
    if (scent.mode !== 'score') throw new Error('no score')
    expect(scent.value).toBeGreaterThanOrEqual(0)
    expect(scent.value).toBeLessThanOrEqual(100)
  })

  it('without a score: a check for tailored work, else the company initial', () => {
    const empty = profileSignals(emptyProfile())
    expect(cardScent(only({ jobs: [job] }), empty, NOW)).toEqual({ mode: 'initial', letter: 'A' })
    expect(cardScent(only({ jobs: [{ ...job, tailoredAt: '2026-10-06T10:00:00Z' }] }), null, NOW)).toEqual({ mode: 'done' })
    expect(cardScent(only({ applications: [app()] }), signals, NOW)).toEqual({ mode: 'done' })
    expect(cardScent(only({ queue: [item()] }), signals, NOW)).toEqual({ mode: 'initial', letter: 'I' })
  })
})

describe('companyOf', () => {
  it('reads the job, the application or the queue title', () => {
    expect(companyOf(only({ jobs: [job] }))).toBe('Acme')
    expect(companyOf(only({ applications: [app()] }))).toBe('Globex')
    expect(companyOf(only({ queue: [item()] }))).toBe('Initech')
  })
})

describe('cardPills', () => {
  it('a saved job: workplace, sponsorship and Tailored', () => {
    const pills = cardPills(only({ jobs: [{ ...job, tailoredAt: '2026-10-06T10:00:00Z' }] }))
    expect(pills.map((p) => [p.label, p.tone])).toEqual([
      ['Remote', 'trail'],
      ['Sponsors visa', 'review'],
      ['Tailored', 'success']
    ])
  })

  it('a run: its status (with a live dot), the agent and Unattended', () => {
    const pills = cardPills(only({ queue: [item({ unattended: true })] }))
    expect(pills.map((p) => [p.label, p.tone, p.variant, !!p.dot])).toEqual([
      ['Working', 'info', 'soft', true],
      ['Codex', 'trail', 'outline', false],
      ['Unattended', 'neutral', 'outline', false]
    ])
    expect(cardPills(only({ queue: [item({ status: 'failed', error: 'boom' })] }))[0]).toMatchObject({
      label: 'Failed',
      tone: 'danger',
      title: 'boom'
    })
  })

  it('an application: review state, build and when it was applied', () => {
    const pills = cardPills(
      only({ applications: [app({}, { status: 'applied', appliedAt: '2026-10-01', review: { state: 'approved', runId: 'r', at: '2026-10-01T00:00:00Z' } })] })
    )
    expect(pills.map((p) => p.label)).toEqual(['Approved', 'ATS passed', 'applied 2026-10-01'])
    const failed = cardPills(only({ applications: [app({ build: { status: 'fail', failed: ['pages'], warnings: 0, resumePages: 2 } })] }))
    expect(failed).toEqual([{ label: 'Build failed', tone: 'danger', variant: 'soft', title: 'pages' }])
  })
})

describe('cardMeta', () => {
  const now = NOW.getTime()
  it('a saved job: how old the posting is', () => {
    expect(cardMeta(only({ jobs: [job] }), now)).toBe('yesterday')
  })
  it('a run: how long it has worked or waited, or when it starts', () => {
    expect(cardMeta(only({ queue: [item()] }), now)).toBe('working 14 min')
    expect(cardMeta(only({ queue: [item({ status: 'needs-reply' })] }), now)).toBe('waiting 14 min')
    expect(cardMeta(only({ queue: [item({ status: 'queued', notBefore: '2026-10-07T12:02:00Z' })] }), now)).toBe('starts in 2 min')
    expect(cardMeta(only({ queue: [item({ status: 'queued' })] }), now)).toBe('queued')
  })
  it('an application: its files, unattended, or days since it was applied', () => {
    expect(cardMeta(only({ applications: [app()] }), now)).toBe('resume.pdf · cover.pdf')
    expect(
      cardMeta(only({ applications: [app({}, { review: { state: 'unreviewed', runId: 'r', at: '2026-10-07T00:00:00Z' } })] }), now)
    ).toBe('unattended')
    expect(cardMeta(only({ applications: [app({}, { status: 'applied', appliedAt: '2026-09-26' })] }), now)).toBe('11 days')
  })
  it('an archived card: when it was archived', () => {
    expect(cardMeta(only({ jobs: [{ ...job, dismissed: true, dismissedAt: '2026-10-05T10:00:00Z' }] }), now)).toBe('archived 2 days ago')
  })
})

describe('ago and span', () => {
  it('formats ages and spans', () => {
    const now = NOW.getTime()
    expect(ago(null, now)).toBe('')
    expect(ago('2026-10-07T01:00:00Z', now)).toBe('today')
    expect(ago('2026-07-01T00:00:00Z', now)).toBe('3 months ago')
    expect(span(10_000)).toBe('<1 min')
    expect(span(3 * 3600_000)).toBe('3 h')
    expect(span(3 * 86_400_000)).toBe('3 days')
  })
})
