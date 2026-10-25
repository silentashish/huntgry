import { describe, expect, it } from 'vitest'
import type { ApplicationRecord } from './applications-types'
import { buildBoard, type BoardCard } from './board'
import { applicationSearchText, cardSearchText, cardSource, EMPTY_BOARD_FILTER, filterBoard, isFilterActive, matchesBoardFilter } from './board-filter'
import type { Job } from './jobs-types'
import type { QueueItem } from './queue-types'

const NOW = new Date('2026-10-07T12:00:00Z')

const job = (over: Partial<Job> & Pick<Job, 'id' | 'source'>): Job => ({
  sourceId: over.id.split(':')[1],
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  salary: '',
  postedAt: null,
  url: `https://jobs.example.com/${over.id}`,
  boardUrl: null,
  description: '',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-06T09:00:00.000Z',
  ...over
})

const app = (id: string, over: Partial<ApplicationRecord> = {}, tracking: Partial<ApplicationRecord['tracking']> = {}): ApplicationRecord => ({
  id: `software-engineer/${id}/${id}-1`,
  role: 'Software Engineer',
  company: id,
  jobId: `${id}-1`,
  jobTitle: 'Platform Engineer',
  jobUrl: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  files: [],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  ...over,
  tracking: { status: 'applied', notes: '', ...tracking }
})

const queued: QueueItem = {
  id: 'q-1',
  jobId: 'url:gone',
  title: 'Data Engineer · Initech',
  options: { coverLetter: true, dateStyle: 'right' },
  agent: 'codex',
  status: 'running',
  runId: null,
  attempts: 1,
  createdAt: '2026-10-07T11:00:00.000Z',
  updatedAt: '2026-10-07T11:46:00.000Z'
}

const board = buildBoard({
  jobs: [job({ id: 'jobright:1', source: 'jobright', company: 'Hooli' }), job({ id: 'pasted:2', source: 'pasted', title: 'SRE' })],
  applications: [app('Globex', {}, { notes: 'Referred by Ana', source: 'url' }), app('Wayne', {}, { source: 'manual' })],
  queue: [queued],
  now: NOW
})
const card = (title: string): BoardCard => board.columns.flatMap((c) => c.cards).find((c) => c.title === title || c.subtitle.includes(title))!
const titles = (f: Parameters<typeof filterBoard>[1]) => filterBoard(board, f).columns.flatMap((c) => c.cards.map((x) => x.subtitle || x.title))

describe('cardSource', () => {
  it("is the saved job's source, else the application's recorded one, else unknown", () => {
    expect(cardSource(card('Hooli'))).toBe('jobright')
    expect(cardSource(card('SRE'))).toBe('pasted')
    expect(cardSource(card('Globex'))).toBe('url')
    // `manual` is not a Board source; a run with no saved job has none.
    expect(cardSource(card('Wayne'))).toBeNull()
    expect(cardSource(card('Data Engineer'))).toBeNull()
  })
})

describe('matchesBoardFilter', () => {
  it('matches everything when empty', () => {
    expect(isFilterActive(EMPTY_BOARD_FILTER)).toBe(false)
    expect(filterBoard(board, EMPTY_BOARD_FILTER)).toBe(board)
    expect(isFilterActive({ text: '  ', sources: [] })).toBe(false)
  })

  it('searches company, role, title and notes, ignoring case and outer spaces', () => {
    expect(matchesBoardFilter(card('Globex'), { text: ' globex ', sources: [] })).toBe(true)
    expect(matchesBoardFilter(card('Globex'), { text: 'software eng', sources: [] })).toBe(true)
    expect(matchesBoardFilter(card('Globex'), { text: 'platform', sources: [] })).toBe(true)
    expect(matchesBoardFilter(card('Globex'), { text: 'ana', sources: [] })).toBe(true)
    expect(matchesBoardFilter(card('Wayne'), { text: 'ana', sources: [] })).toBe(false)
    expect(matchesBoardFilter(card('Data Engineer'), { text: 'initech', sources: [] })).toBe(true)
  })

  it("searches an application's job id, as the Dashboard table did (#161)", () => {
    const req = app('Umbrella', { jobId: 'REQ-4711', jobTitle: 'Data Engineer', role: 'Data Engineer' })
    const board = buildBoard({ jobs: [], applications: [req], queue: [], now: NOW })
    const umbrella = board.columns.flatMap((c) => c.cards)[0]
    // The id is in none of the other searched fields.
    expect(cardSearchText(umbrella).filter((s) => s.includes('4711'))).toEqual(['REQ-4711'])
    expect(matchesBoardFilter(umbrella, { text: 'req-4711', sources: [] })).toBe(true)
    expect(applicationSearchText(req)).toContain('REQ-4711')
  })

  it("searches the application a working queue item superseded, as the Dashboard table did (#161)", () => {
    const saved = job({ id: 'url:9', source: 'url', company: 'Umbrella', title: 'Data Engineer' })
    const superseded = app('Umbrella', { jobId: 'REQ-9', jobUrl: saved.url }, { status: 'generated', notes: 'Recruiter: Dana' })
    const rerun: QueueItem = { ...queued, id: 'q-9', jobId: saved.id, title: 'Data Engineer · Umbrella' }
    const b = buildBoard({ jobs: [saved], applications: [superseded], queue: [rerun], now: NOW })
    const only = b.columns.flatMap((c) => c.cards)
    expect(only.map((c) => c.key)).toEqual(['queue:q-9'])
    expect(matchesBoardFilter(only[0], { ...EMPTY_BOARD_FILTER, text: 'dana' })).toBe(true)
    expect(matchesBoardFilter(only[0], { ...EMPTY_BOARD_FILTER, text: 'req-9' })).toBe(true)
  })

  it('keeps only the chosen sources; a card with no known source is left out', () => {
    expect(titles({ text: '', sources: ['jobright'] })).toEqual(['Hooli · Remote'])
    expect(titles({ text: '', sources: ['url', 'pasted'] }).sort()).toEqual(['Acme · Remote', 'Globex'])
    expect(titles({ text: 'hooli', sources: ['pasted'] })).toEqual([])
  })

  it('narrows every column at once, so the counts are those of the filtered set', () => {
    const out = filterBoard(board, { text: 'engineer', sources: [] })
    expect(out.columns.map((c) => [c.id, c.cards.length]).filter(([, n]) => n)).toEqual([
      ['todo', 1],
      ['tailoring', 1],
      ['applied', 2]
    ])
    expect(out.hiddenArchived).toBe(board.hiddenArchived)
  })
})
