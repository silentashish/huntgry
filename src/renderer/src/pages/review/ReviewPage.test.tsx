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
})
