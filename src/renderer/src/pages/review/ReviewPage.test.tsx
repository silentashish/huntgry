// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewDetail, ReviewItem, ReviewOutcome } from '@shared/review-types'
import { NavigationContext, type Navigation, type PageParams } from '../../navigation'

/** Review page (#114): which result opens, late responses, and the next result after a decision. */

const item = (applicationId: string, state: ReviewItem['state'] = 'unreviewed'): ReviewItem => ({
  applicationId,
  runId: `run-${applicationId}`,
  title: `Role ${applicationId}`,
  state,
  at: '2026-10-05T06:00:00.000Z',
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  hasCover: false,
  jobUrl: null
})

const detailOf = (i: ReviewItem, state: ReviewDetail['state'] = i.state): ReviewDetail => ({
  applicationId: i.applicationId,
  runId: i.runId,
  title: i.title,
  state,
  jobUrl: null,
  reviewNotes: null,
  usedApprovals: [],
  openGaps: [],
  proposedReframings: [],
  verify: { ok: true, report: '' },
  build: i.build,
  artifacts: [],
  resumePages: [],
  coverPages: [],
  revision: `rev-${i.applicationId}`
})

const review = {
  list: vi.fn<() => Promise<ReviewItem[]>>(),
  get: vi.fn<(id: string) => Promise<ReviewDetail>>(),
  approve: vi.fn<() => Promise<ReviewOutcome>>(),
  rerun: vi.fn(),
  discard: vi.fn(),
  approvals: vi.fn(async () => ({ approvals: [], leftOut: 0 }))
}

const nav: Navigation = { location: { page: 'review', params: undefined }, navigate: vi.fn(), setLeaveGuard: vi.fn() }

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, { huntgry: { review, applications: { openFile: vi.fn(), fileUrl: () => '' }, on: () => () => undefined } })
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  // The Decision card's autosize Textarea listens for font loads; jsdom has no document.fonts.
  if (!('fonts' in document)) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderPage(params: PageParams['review']) {
  const { ReviewPage } = await import('.')
  await act(async () =>
    root.render(
      <MantineProvider>
        <NavigationContext.Provider value={nav}>
          <ReviewPage params={params} />
        </NavigationContext.Provider>
      </MantineProvider>
    )
  )
}

/** The title of the result shown in the detail. */
const shownTitle = () => container.querySelector('h3')?.textContent ?? null

const listButton = (title: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('section button')].find((b) => b.textContent?.includes(title))
  if (!found) throw new Error(`no result "${title}"`)
  return found
}

describe('ReviewPage', () => {
  it('opens the first result when no result is asked for', async () => {
    const items = [item('a'), item('b')]
    review.list.mockResolvedValue(items)
    review.get.mockImplementation(async (id) => detailOf(items.find((i) => i.applicationId === id)!))
    await renderPage(undefined)
    expect(review.get.mock.calls.map((c) => c[0])).toEqual(['a'])
    expect(shownTitle()).toBe('Role a')
  })

  it('opens the asked-for result and never the first one', async () => {
    const items = [item('a'), item('b')]
    review.list.mockResolvedValue(items)
    review.get.mockImplementation(async (id) => detailOf(items.find((i) => i.applicationId === id)!))
    await renderPage({ applicationId: 'b' })
    expect(review.get.mock.calls.map((c) => c[0])).toEqual(['b'])
    expect(shownTitle()).toBe('Role b')
  })

  it('ignores a late response for a result the user already left', async () => {
    const items = [item('a'), item('b')]
    review.list.mockResolvedValue(items)
    let resolveA: (d: ReviewDetail) => void = () => undefined
    review.get.mockImplementation((id) => (id === 'a' ? new Promise<ReviewDetail>((r) => (resolveA = r)) : Promise.resolve(detailOf(items[1]))))
    await renderPage(undefined)
    expect(review.get).toHaveBeenCalledWith('a')

    await act(async () => listButton('Role b').click())
    expect(shownTitle()).toBe('Role b')

    // The auto-open's response for "a" arrives last: it must not replace "b".
    await act(async () => resolveA(detailOf(items[0])))
    expect(shownTitle()).toBe('Role b')
    expect(container.textContent).not.toContain('Pick a result on the left.')
  })

  it('after a decision opens the next result the filter shows', async () => {
    const items = [item('a'), item('b'), item('c', 'needs-attention'), item('d', 'needs-attention')]
    review.list.mockResolvedValue(items)
    review.get.mockImplementation(async (id) => detailOf(items.find((i) => i.applicationId === id)!))
    await renderPage(undefined)

    // Attention filter, then open "c" and approve it.
    const attention = container.querySelector<HTMLInputElement>('input[type="radio"][value="attention"]')!
    await act(async () => attention.click())
    await act(async () => listButton('Role c').click())
    expect(shownTitle()).toBe('Role c')

    review.list.mockResolvedValue(items.filter((i) => i.applicationId !== 'c'))
    review.approve.mockResolvedValue({ ok: true, detail: detailOf(items[2], 'approved') })
    review.get.mockClear()
    const approve = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Approve'))!
    await act(async () => approve.click())

    // "a" comes first in the list, but the Attention filter hides it: "d" opens.
    expect(review.get.mock.calls.map((c) => c[0])).toEqual(['d'])
    expect(shownTitle()).toBe('Role d')
  })

  it('shows a v2 result as Reframings used, Gaps left open and Decisions, with direct hits folded (#158)', async () => {
    const items = [item('a')]
    review.list.mockResolvedValue(items)
    review.get.mockResolvedValue({
      ...detailOf(items[0]),
      notesFormat: 'v2',
      reviewNotes: '# Tailoring notes\n<!-- resume-tailor notes v2 -->\n',
      proposedReframings: [{ id: 'f'.repeat(64), requirement: 'Kafka', sourceFact: 'Built a RabbitMQ pipeline', wording: 'Built event-streaming pipelines' }],
      openGaps: ['Go: never used'],
      decisions: ['Right-aligned dates.'],
      directHits: ['Node: five years']
    })
    await renderPage(undefined)
    const text = container.textContent ?? ''
    expect(text).toContain('Reframings used')
    expect(text).toContain('preferred wordings')
    expect(text).toContain('Gaps left open')
    expect(text).toContain('Go: never used')
    expect(text).toContain('Decisions')
    expect(text).toContain('Right-aligned dates.')
    expect(text).toContain('Show direct hits (1)')
    expect(text).toContain('Tailoring notes')
    expect(text).not.toContain('left out')
    expect(container.querySelector('[aria-label="Keep: Built event-streaming pipelines"]')).not.toBeNull()
    // The page itself no longer speaks of unattended runs or a "Run unattended" mode.
    expect(text).not.toMatch(/Run unattended|Unattended runs use only/)
  })

  it('shows an older v1 result as before (AC-4)', async () => {
    const items = [item('a')]
    review.list.mockResolvedValue(items)
    review.get.mockResolvedValue({
      ...detailOf(items[0]),
      notesFormat: 'v1',
      proposedReframings: [{ id: 'e'.repeat(64), sourceFact: 'Mentored two juniors', wording: 'Led a team of two', reason: 'mentoring is not leading' }],
      openGaps: ['Rust: nothing honest to say']
    })
    await renderPage(undefined)
    const text = container.textContent ?? ''
    expect(text).toContain('Proposed reframings the run left out')
    expect(text).toContain('Open gaps')
    expect(text).toContain('Why unsure')
    expect(text).toContain('Review notes')
    expect(container.querySelector('[aria-label="Approve: Led a team of two"]')).not.toBeNull()
  })

  it('shows profile fit vs resume coverage in Verify (#151)', async () => {
    const items = [item('a')]
    review.list.mockResolvedValue(items)
    review.get.mockResolvedValue({
      ...detailOf(items[0]),
      match: { profileFit: 82, resumeCoverage: 74, surfaced: 90, requirements: 11, leftOut: ['Kafka'], resumeFrom: 'resume_data.json', source: 'description', at: '2026-10-24T12:00:00.000Z' }
    })
    await renderPage(undefined)
    const box = container.querySelector('[data-testid="resume-match"]')!
    expect(box.textContent).toContain('Profile fit 82 · Resume 74 (90% surfaced)')
    expect(box.textContent).toContain('Kafka')
  })

  it('refreshes the open result\'s match when main stores a new one, keeping the rest as shown (#151 review)', async () => {
    const items = [item('a')]
    review.list.mockResolvedValue(items)
    review.get.mockResolvedValue(detailOf(items[0]))
    const w = window as unknown as { huntgry: { on: unknown; applications: Record<string, unknown> } }
    const listeners: Array<() => void> = []
    const on = w.huntgry.on
    w.huntgry.on = (channel: string, fn: () => void) => {
      if (channel === 'applications:changed') listeners.push(fn)
      return () => undefined
    }
    const match = { profileFit: 82, resumeCoverage: 74, surfaced: 90, requirements: 11, leftOut: ['Kafka'], resumeFrom: 'resume_data.json', source: 'description', at: '2026-10-24T12:00:00.000Z' }
    const get = vi.fn(async () => ({ tracking: { status: 'generated', notes: '', match } }))
    w.huntgry.applications.get = get
    try {
      await renderPage(undefined)
      expect(container.querySelector('[data-testid="resume-match"]')).toBeNull()
      // The re-run's turn ends and main writes the new match: the same result stays open.
      await act(async () => listeners.forEach((fn) => fn()))
      expect(get).toHaveBeenCalledWith('a')
      expect(container.querySelector('[data-testid="resume-match"]')?.textContent).toContain('Profile fit 82 · Resume 74 (90% surfaced)')
      // Only the match is fetched again: the revision-pinned detail is not reloaded.
      expect(review.get).toHaveBeenCalledTimes(1)

      // A later re-score that drops it (the resume is gone) clears it too.
      get.mockResolvedValueOnce({ tracking: { status: 'generated', notes: '' } } as never)
      await act(async () => listeners.forEach((fn) => fn()))
      expect(container.querySelector('[data-testid="resume-match"]')).toBeNull()
    } finally {
      w.huntgry.on = on
      delete w.huntgry.applications.get
    }
  })
})
