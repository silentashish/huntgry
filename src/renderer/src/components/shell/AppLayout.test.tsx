// @vitest-environment jsdom
import { act, useEffect, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { Location } from '../../navigation'

/**
 * The shell with its ⌘K palette (#108): the in-app browser's native view is hidden while the palette covers
 * the Browser page and shown again only if that page is still on screen; Enter runs the selected row; Tab
 * jumps between groups; commands that leave the page wait for the unsaved-changes guard.
 */

const initech: Job = {
  id: 'pasted:1',
  source: 'pasted',
  sourceId: '1',
  title: 'Staff Backend Engineer',
  company: 'Initech',
  location: '',
  remote: false,
  salary: '',
  postedAt: null,
  url: 'https://jobs.example.com/1',
  boardUrl: null,
  description: 'Build things.',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-01T00:00:00Z'
}

const api = {
  browser: { setVisible: vi.fn(async (_visible: boolean) => undefined) },
  jobs: { list: vi.fn(async () => [initech]), update: vi.fn(async () => initech), fetchDetails: vi.fn(async () => initech) },
  applications: { list: vi.fn(async () => ({ applications: [], truncated: false })) },
  runner: { listRuns: vi.fn(async () => []) },
  review: { list: vi.fn(async () => []) },
  pipeline: { state: vi.fn(async () => null) },
  automation: { state: vi.fn(async () => null) },
  on: () => () => undefined
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, { huntgry: api })
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= function () {}
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

/** The Browser page's contract with the native view: shown while mounted, hidden in its layout cleanup. */
function FakeBrowser() {
  useLayoutEffect(() => {
    void api.browser.setVisible(true)
    return () => void api.browser.setVisible(false)
  }, [])
  return <h2>Browser page</h2>
}

async function renderShell(start: Location, guard: string | null = null) {
  const { AppLayout } = await import('./AppLayout')
  const { useNavigation } = await import('../../navigation')
  function Page({ location }: { location: Location }) {
    const { setLeaveGuard } = useNavigation()
    useEffect(() => setLeaveGuard(guard), [setLeaveGuard])
    return location.page === 'browser' ? <FakeBrowser /> : <h2>{`${location.page} page`}</h2>
  }
  await act(async () =>
    root.render(
      <MantineProvider>
        <AppLayout workspacePath="/tmp/cv" initialLocation={start} onSwitchWorkspace={() => undefined}>
          {(location) => <Page location={location} />}
        </AppLayout>
      </MantineProvider>
    )
  )
}

const heading = () => container.querySelector('h2')?.textContent
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Sniff anything"]')
const selected = () => document.querySelector('[role="option"][aria-selected="true"]')?.querySelector('span span')?.textContent

async function openPalette() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  })
  // Let the palette's data load and its transition run.
  await settle()
  expect(input()).not.toBeNull()
}

/** Lets Mantine's open / close transitions (120–200 ms) and pending promises finish. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 300)))

async function type(text: string) {
  await act(async () => {
    const el = input()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    input()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
  if (key === 'Enter' || key === 'Escape') await settle()
}

const lastVisible = () => api.browser.setVisible.mock.calls.at(-1)?.[0]

describe('command palette in the shell', () => {
  it('on the Browser page, choosing another page leaves the native view hidden', async () => {
    await renderShell({ page: 'browser', params: undefined })
    expect(lastVisible()).toBe(true)
    await openPalette()
    expect(lastVisible()).toBe(false)
    await type('jobs')
    expect(selected()).toBe('Jobs')
    await press('Enter')
    expect(heading()).toBe('jobs page')
    // The Browser page hid its view as it went away; nothing showed it again over the Jobs page.
    expect(lastVisible()).toBe(false)
  })

  it('on the Browser page, closing the palette shows the native view again', async () => {
    await renderShell({ page: 'browser', params: undefined })
    await openPalette()
    expect(lastVisible()).toBe(false)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    })
    await settle()
    expect(heading()).toBe('Browser page')
    expect(lastVisible()).toBe(true)
  })

  it('never touches the native view on other pages', async () => {
    await renderShell({ page: 'dashboard', params: undefined })
    await openPalette()
    await press('Escape')
    expect(api.browser.setVisible).not.toHaveBeenCalled()
  })

  it('Enter runs the selected row; the arrows move the selection', async () => {
    await renderShell({ page: 'dashboard', params: undefined })
    await openPalette()
    expect(selected()).toBe('Dashboard')
    await press('ArrowDown')
    await press('ArrowDown')
    expect(selected()).toBe('Jobs')
    await press('ArrowUp')
    expect(selected()).toBe('Board')
    await press('Enter')
    expect(heading()).toBe('board page')
    expect(input()).toBeNull()
  })

  it('Tab jumps to the next group, Shift+Tab back', async () => {
    await renderShell({ page: 'dashboard', params: undefined })
    await openPalette()
    expect(selected()).toBe('Dashboard')
    await press('Tab')
    expect(selected()).toBe('New tailored resume')
    await press('Tab', { shiftKey: true })
    expect(selected()).toBe('Dashboard')
  })

  it('a command that leaves the page waits for the unsaved-changes guard, and does nothing on Keep editing', async () => {
    await renderShell({ page: 'profile', params: undefined }, 'The master profile has 2 unsaved fields.')
    await openPalette()
    await type('initech')
    await press('Tab')
    expect(selected()).toBe('Tailor a resume for Initech…')
    await press('Enter')
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes('Discard unsaved changes?'))
    expect(dialog?.textContent).toContain('The master profile has 2 unsaved fields.')
    // Nothing ran yet: the job is not marked tailored.
    expect(api.jobs.update).not.toHaveBeenCalled()
    const keep = [...dialog!.querySelectorAll('button')].find((b) => b.textContent === 'Keep editing')!
    await act(async () => keep.click())
    await settle()
    expect(api.jobs.update).not.toHaveBeenCalled()
    expect(heading()).toBe('profile page')

    // Discard and leave: now it runs and opens the Tailor form.
    await openPalette()
    await type('initech')
    await press('Tab')
    await press('Enter')
    const again = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes('Discard unsaved changes?'))!
    const discard = [...again.querySelectorAll('button')].find((b) => b.textContent === 'Discard and leave')!
    await act(async () => discard.click())
    await settle()
    expect(api.jobs.update).toHaveBeenCalledWith('pasted:1', { tailored: true })
    expect(heading()).toBe('tailor page')
  })
})
