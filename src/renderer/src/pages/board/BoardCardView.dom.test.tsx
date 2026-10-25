// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationRecord } from '@shared/applications-types'
import { buildBoard, type BoardCard } from '@shared/board'
import type { Job } from '@shared/jobs-types'
import { BoardCardView } from './BoardCardView'
import { cardScent } from './card'

/** The Board card in a DOM (#110): the Move to menu by card kind, the current column, Enter to open, Apply busy. */

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

const app: ApplicationRecord = {
  id: 'software-engineer/globex/g-1',
  role: 'Software Engineer',
  company: 'Globex',
  jobId: 'g-1',
  jobTitle: 'Platform Engineer',
  jobUrl: 'https://jobs.example.com/g',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  files: ['resume.pdf'],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  tracking: { status: 'generated', notes: '' }
}

const only = (input: Partial<Parameters<typeof buildBoard>[0]>): BoardCard =>
  buildBoard({ jobs: [], applications: [], queue: [], now: new Date('2026-10-07T00:00:00Z'), ...input }).columns.flatMap((c) => c.cards)[0]

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

let container: HTMLDivElement
let root: Root
const handlers = { onOpen: vi.fn(), onMove: vi.fn(), onTailor: vi.fn(), onApply: vi.fn(), onOpenApplication: vi.fn() }

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

function render(card: BoardCard, applying = false) {
  act(() =>
    root.render(
      <MantineProvider env="test">
        <BoardCardView
          card={card}
          scent={cardScent(card, null)}
          dragging={false}
          onDragStart={() => undefined}
          onDragEnd={() => undefined}
          onFollow={() => undefined}
          applying={applying}
          {...handlers}
        />
      </MantineProvider>
    )
  )
}

const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)
const items = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]
const openMenu = (title: string) => act(() => button(`Move ${title}`)!.click())

describe('BoardCardView menu and keyboard', () => {
  it("a saved job's menu ticks To do and ends with Dismiss job, not Archive", () => {
    render(only({ jobs: [job] }))
    openMenu('Backend Engineer')
    const current = items().find((i) => i.getAttribute('aria-label') === 'To do (current column)')
    expect(current).toBeDefined()
    expect(current!.disabled || current!.hasAttribute('data-disabled')).toBe(true)
    expect(items().map((i) => i.textContent?.trim())).toEqual(['To do', 'Dismiss job'])
    act(() => items().find((i) => i.textContent?.trim() === 'Dismiss job')!.click())
    expect(handlers.onMove).toHaveBeenCalledWith('archived')
  })

  it("an application's menu ticks its column and ends with Archive", () => {
    render(only({ applications: [app] }))
    openMenu('Platform Engineer')
    const names = items().map((i) => i.textContent?.trim())
    expect(names).toEqual(['Ready to apply', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Archive'])
    expect(items()[0].getAttribute('aria-label')).toBe('Ready to apply (current column)')
    expect(items().slice(1).every((i) => !i.disabled && !i.hasAttribute('data-disabled'))).toBe(true)
    act(() => items()[0].click())
    expect(handlers.onMove).not.toHaveBeenCalled()
  })

  it('Enter on the card opens it; Enter on a button inside does not', () => {
    render(only({ jobs: [job] }))
    const article = container.querySelector('article')!
    act(() => {
      article.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(handlers.onOpen).toHaveBeenCalledTimes(1)
    act(() => {
      button('Tailor')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(handlers.onOpen).toHaveBeenCalledTimes(1)
  })

  it('a queue card re-running an application opens that application; others have no such button (#161)', () => {
    const item = { id: 'q-1', jobId: job.id, title: 'Backend Engineer · Acme', options: { coverLetter: false, dateStyle: 'right' as const }, agent: 'claude' as const, status: 'running' as const, runId: null, attempts: 1, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' }
    const rerun = { ...app, jobUrl: job.url }
    render(only({ jobs: [job], applications: [rerun], queue: [item] }))
    const open = button('Open the application')
    expect(open).toBeDefined()
    act(() => open!.click())
    expect(handlers.onOpenApplication).toHaveBeenCalledTimes(1)
    // The card's own click still follows the run.
    expect(handlers.onOpen).not.toHaveBeenCalled()

    render(only({ jobs: [job], queue: [item] }))
    expect(button('Open the application')).toBeUndefined()
  })

  it('Apply waits while an Apply is starting', () => {
    render(only({ applications: [app] }))
    expect(button('Apply')!.disabled).toBe(false)
    render(only({ applications: [app] }), true)
    const apply = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Apply'))!
    expect(apply.disabled).toBe(true)
    expect(apply.hasAttribute('data-loading')).toBe(true)
  })

  it("an application card shows its profile fit and resume coverage on one line (#151)", () => {
    const match = {
      profileFit: 82,
      resumeCoverage: 74,
      surfaced: 90,
      requirements: 11,
      leftOut: ['Kubernetes'],
      resumeFrom: 'resume_data.json' as const,
      source: 'description' as const,
      at: '2026-10-24T12:00:00.000Z'
    }
    render(only({ applications: [{ ...app, tracking: { ...app.tracking, match } }] }))
    const line = [...container.querySelectorAll('div')].find((d) => d.textContent === 'Profile fit 82 · Resume 74 (90% surfaced)')!
    expect(line).toBeDefined()
    expect(line.getAttribute('title')).toContain('Left out: Kubernetes')
    render(only({ applications: [app] }))
    expect(container.textContent).not.toContain('Profile fit')
  })
})
