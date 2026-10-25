// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationRecord } from '@shared/applications-types'
import { NavigationContext, type Navigation } from '../../navigation'
import { ApplicationDrawer } from './ApplicationDrawer'

/**
 * The application drawer the Board opens (#161): every action of the Dashboard table's rows is
 * here, Apply, resume.pdf, cover.pdf, the posting, the folder, the status, the build result and
 * the review state.
 */

const api = vi.hoisted(() => ({
  applications: {
    readJobDescription: vi.fn(async () => '# Platform Engineer'),
    openFile: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    fileUrl: (id: string, f: string) => `huntgry-file://app/${id}/${f}`
  },
  runner: { listRuns: vi.fn(async () => []) }
}))
vi.mock('../../api', () => ({ api, errorText: String }))

const app: ApplicationRecord = {
  id: 'software-engineer/globex/g-1',
  role: 'Software Engineer',
  company: 'Globex',
  jobId: 'g-1',
  jobTitle: 'Platform Engineer',
  jobUrl: 'https://jobs.example.com/g',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  files: ['resume.pdf', 'cover.pdf'],
  resumePages: [],
  coverPages: [],
  build: { status: 'fail', failed: ['page count'], warnings: 0, resumePages: 2 },
  tracking: { status: 'generated', notes: '' }
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => undefined
  // The Notes textarea autosizes and listens for font loads, which jsdom does not have.
  if (!('fonts' in document)) Object.defineProperty(document, 'fonts', { value: new EventTarget() })
})

let container: HTMLDivElement
let root: Root
const navigate = vi.fn()
const handlers = { onClose: vi.fn(), onUpdate: vi.fn(async () => undefined), onApply: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(record: ApplicationRecord) {
  const nav: Navigation = { location: { page: 'board', params: undefined }, navigate, setLeaveGuard: () => undefined }
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <NavigationContext.Provider value={nav}>
          <ApplicationDrawer app={record} applying={false} {...handlers} />
        </NavigationContext.Provider>
      </MantineProvider>
    )
  )
}

const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)
const click = (name: string) => act(async () => button(name)!.click())

describe('ApplicationDrawer: the table row actions (#161)', () => {
  it('Apply starts auto-apply for the application', async () => {
    await render(app)
    await click('Apply in browser')
    expect(handlers.onApply).toHaveBeenCalledWith(app)
  })

  it('opens resume.pdf and cover.pdf', async () => {
    await render(app)
    await click('Open resume')
    expect(api.applications.openFile).toHaveBeenCalledWith(app.id, 'resume.pdf')
    await click('Open cover letter')
    expect(api.applications.openFile).toHaveBeenCalledWith(app.id, 'cover.pdf')
  })

  it('has no resume or cover letter buttons when the files are missing, and Apply says why', async () => {
    await render({ ...app, files: [] })
    expect(button('Open cover letter')).toBeUndefined()
    // The only "Open resume" left is the empty preview's link.
    expect(document.querySelectorAll('button[aria-label="Open resume"]')).toHaveLength(0)
    expect(button('Apply in browser')!.disabled).toBe(true)
  })

  it('opens the posting in the in-app browser', async () => {
    await render(app)
    await click('Job posting')
    expect(navigate).toHaveBeenCalledWith('browser', { url: 'https://jobs.example.com/g' })
  })

  it('shows the folder in Finder', async () => {
    await render(app)
    await click('Show in Finder')
    expect(api.applications.reveal).toHaveBeenCalledWith(app.id)
  })

  it('changes the status from its dropdown', async () => {
    await render(app)
    const input = [...document.querySelectorAll('input')].find((i) => i.value === 'Generated')!
    await act(async () => input.click())
    const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === 'Interviewing') as HTMLElement
    expect(option).toBeDefined()
    await act(async () => option.click())
    expect(handlers.onUpdate).toHaveBeenCalledWith({ status: 'interviewing' })
  })

  it('shows the build result and the review state, and opens an open review on Review', async () => {
    await render({ ...app, tracking: { status: 'generated', notes: '', review: { state: 'needs-attention', runId: 'r', at: '2026-10-02T00:00:00.000Z' } } })
    expect(document.body.textContent).toContain('Build failed: page count')
    expect(document.body.textContent).toContain('Needs attention')
    await click('Open in Review')
    expect(navigate).toHaveBeenCalledWith('review', { applicationId: app.id })
  })
})
