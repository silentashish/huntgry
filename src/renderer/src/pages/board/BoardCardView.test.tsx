import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it, vi } from 'vitest'
import type { ApplicationRecord } from '@shared/applications-types'
import { buildBoard, type BoardCard } from '@shared/board'
import type { Job } from '@shared/jobs-types'
import type { QueueItem } from '@shared/queue-types'
import { BoardCardView } from './BoardCardView'
import { cardMatch, type CardMatch } from './card'

// The preload bridge does not exist here; a card only calls it through its handlers.
vi.mock('../../api', () => ({ api: {}, errorText: String }))

const job: Job = {
  id: 'url:a',
  source: 'url',
  sourceId: 'a',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  salary: '',
  postedAt: null,
  url: 'https://jobs.example.com/a',
  boardUrl: null,
  description: 'Go.',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-01T00:00:00.000Z'
}

const app = (over: Partial<ApplicationRecord['tracking']>): ApplicationRecord => ({
  id: 'software-engineer/globex/g-1',
  role: 'Software Engineer',
  company: 'Globex',
  jobId: 'g-1',
  jobTitle: 'Platform Engineer',
  jobUrl: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  files: ['resume.pdf'],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  tracking: { status: 'generated', notes: '', ...over }
})

const item: QueueItem = {
  id: 'q-1',
  jobId: 'url:a',
  title: 'Backend Engineer · Acme',
  options: { coverLetter: true, dateStyle: 'right' },
  agent: 'claude',
  status: 'needs-reply',
  runId: '20261003-000000-aaaaaa',
  attempts: 1,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z'
}

const only = (input: Parameters<typeof buildBoard>[0]): BoardCard => {
  const cards = buildBoard({ now: new Date('2026-10-07T00:00:00Z'), ...input }).columns.flatMap((c) => c.cards)
  expect(cards).toHaveLength(1)
  return cards[0]
}

const noop = () => undefined
const render = (card: BoardCard, match: CardMatch = cardMatch(card, null), compact = false) =>
  renderToStaticMarkup(
    <MantineProvider>
      <BoardCardView
        card={card}
        match={match}
        dragging={false}
        onDragStart={noop}
        onDragEnd={noop}
        onOpen={noop}
        onMove={noop}
        onTailor={noop}
        onFollow={noop}
        onApply={noop}
        compact={compact}
      />
    </MantineProvider>
  )

describe('BoardCardView', () => {
  it('a To do card offers Tailor and Move, and can be dragged', () => {
    const html = render(only({ jobs: [job], applications: [], queue: [] }))
    expect(html).toContain('aria-label="Backend Engineer"')
    expect(html).toContain('Acme · Remote')
    expect(html).toMatch(/>Tailor</)
    expect(html).toContain('aria-label="Move Backend Engineer"')
    expect(html).toContain('draggable="true"')
    // The company avatar and, without a profile to score against, the company's initial in the ring.
    expect(html).toContain('role="img" aria-label="Acme"')
    expect(html).toContain('aria-label="No match score yet"')
    expect(html).toContain('Remote')
  })

  it('shows the match score in the ring when there is one', () => {
    const card = only({ jobs: [job], applications: [], queue: [] })
    const html = render(card, { mode: 'score', value: 87, estimate: false, reasons: ['Remote'] })
    expect(html).toContain('aria-label="Match 87 of 100"')
    expect(html).toMatch(/>87</)
  })

  it('a run waiting for a reply links to it and cannot be moved', () => {
    const html = render(only({ jobs: [job], applications: [], queue: [item] }))
    expect(html).toContain('Needs your reply')
    expect(html).toMatch(/>Reply</)
    expect(html).not.toContain('aria-label="Move')
    expect(html).toContain('draggable="false"')
  })

  it('an application shows its build and review state; an unreviewed one links to Review', () => {
    const ready = render(only({ jobs: [], applications: [app({ appliedAt: '2026-10-05', status: 'applied' })], queue: [] }))
    expect(ready).toContain('ATS passed')
    expect(ready).toContain('applied 2026-10-05')
    expect(ready).not.toMatch(/>Review</)
    // An application with nothing to score shows the "done" ring.
    expect(ready).toContain('aria-label="Tailored"')
    const unreviewed = render(
      only({
        jobs: [],
        applications: [app({ review: { state: 'unreviewed', runId: 'r', at: '2026-10-04T00:00:00.000Z' } })],
        queue: []
      })
    )
    expect(unreviewed).toContain('Unreviewed')
    expect(unreviewed).toMatch(/>Review</)
    expect(unreviewed).not.toMatch(/>Apply</)
  })

  it('a result ready to apply with a posting URL and resume.pdf offers Apply', () => {
    const ready = { ...app({}), jobUrl: 'https://jobs.example.com/g', files: ['resume.pdf', 'cover.pdf'] }
    const html = render(only({ jobs: [], applications: [ready], queue: [] }))
    expect(html).toMatch(/>Apply</)
    expect(html).toContain('resume.pdf · cover.pdf')
    const noUrl = render(only({ jobs: [], applications: [app({})], queue: [] }))
    expect(noUrl).not.toMatch(/>Apply</)
  })

  it('a card of an older week (#160) adds one line with the company, the title and the score, and keeps the full card and Move to', () => {
    const card = only({ jobs: [job], applications: [], queue: [] })
    const html = render(card, { mode: 'score', value: 87, estimate: false, reasons: [] }, true)
    expect(html).toContain('data-compact="true"')
    expect(html).toContain('Acme · Backend Engineer')
    expect(html).toMatch(/>87<\/span><\/div>/)
    // The full card is still there for hover and focus, and moving works as on any card.
    expect(html).toMatch(/>Tailor</)
    expect(html).toContain('aria-label="Move Backend Engineer"')
    expect(render(card)).not.toContain('data-compact')
  })
})
