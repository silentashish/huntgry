// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toJob } from '@shared/explore-score'
import type { ExploreJob, ExploreList } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import type { PageParams } from '../../navigation'

/**
 * The Jobs page in a DOM (#189): Discover and Saved tabs over one saved list. The tab it opens on, Discover's
 * "Saved ✓" opening the job on Saved, one "Add job" on both tabs, and the match score Saved rows show (the number
 * the Discover row shows).
 */

const today = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()
const row: ExploreJob = {
  id: 'northwind1',
  company: 'Northwind Labs',
  companyUrl: null,
  title: 'Software Engineer, New Grad',
  url: 'https://jobright.ai/jobs/info/northwind1',
  location: 'Seattle, WA',
  workModel: 'Hybrid',
  postedAt: today,
  qualifications: '1. Python or Go. 2. Kubernetes and Terraform. 3. React and TypeScript.'
}
const list: ExploreList = { jobs: [row], fetchedAt: new Date().toISOString(), category: 'newgrad:us:swe', source: 'api' }

const state = { saved: [] as Job[] }
const profile = (() => {
  const p = emptyProfile()
  p.contact.headline = 'Software Engineer'
  p.skills = [{ category: 'Languages', items: ['Python', 'Go'] }]
  return p
})()

vi.mock('../../api', () => ({
  api: {
    jobs: {
      list: async () => state.saved,
      prefs: async () => ({ filters: undefined }),
      setPrefs: async () => undefined
    },
    profile: { read: async () => ({ profile }) },
    explore: {
      account: async () => ({ connected: true, checkedAt: null }),
      list: async () => list,
      refresh: async () => list,
      add: async () => toJob(row, new Date())
    }
  },
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
vi.mock('../../components/queue/useQueue', () => ({ useQueue: () => [null, () => undefined] }))
/** Navigation as the shell does it, for this page only: a new location re-renders the page with its params. */
const navigation = { navigate: vi.fn((_page: string, params?: PageParams['jobs']) => draw(params)) }
vi.mock('../../navigation', () => ({ useNavigation: () => navigation }))

const { JobsPage } = await import('./index')

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => undefined
  // Mantine's autosize Textarea (Add job) listens for web fonts loading.
  ;(document as { fonts?: unknown }).fonts ??= { addEventListener() {}, removeEventListener() {} }
})

let container: HTMLDivElement
let root: Root

function draw(params?: PageParams['jobs']) {
  root.render(
    <MantineProvider env="test">
      <JobsPage params={params} />
    </MantineProvider>
  )
}
async function open(params?: PageParams['jobs']) {
  await act(async () => {
    draw(params)
    await new Promise((r) => setTimeout(r, 0))
  })
}
async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  state.saved = []
  navigation.navigate.mockClear()
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

/** The tab switch's checked option. */
const currentTab = () => container.querySelector<HTMLInputElement>('[aria-label="Jobs view"] input:checked')?.value
const buttons = (name: string) => [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name)
const badge = (list: string) => container.querySelector(`[aria-label="${list}"] li [role="img"]`)?.getAttribute('aria-label')

describe('Jobs tabs (#189)', () => {
  it('opens on Discover when nothing is saved, and on Saved when something is', async () => {
    await open()
    expect(currentTab()).toBe('discover')
    act(() => root.unmount())
    root = createRoot(container)
    state.saved = [toJob(row, new Date())]
    await open()
    expect(currentTab()).toBe('saved')
    expect(container.textContent).toContain('Saved (1)')
  })

  it('has one "Add job" in the header on both tabs, and Tailor all only on Saved', async () => {
    state.saved = [toJob(row, new Date())]
    await open({ tab: 'discover' })
    expect(buttons('Add job')).toHaveLength(1)
    expect(buttons('Tailor all')).toHaveLength(0)
    expect(buttons('Paste a job')).toHaveLength(0)
    await open({ tab: 'saved' })
    expect(currentTab()).toBe('saved')
    expect(buttons('Add job')).toHaveLength(1)
    expect(buttons('Tailor all')).toHaveLength(1)
    await click(buttons('Add job')[0])
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Link or posting text')
  })

  it('"Saved ✓" on Discover switches to Saved and opens the job, with the score its row showed', async () => {
    const saved = toJob(row, new Date())
    state.saved = [saved]
    await open({ tab: 'discover' })
    const discoverScore = badge('Jobright jobs')
    expect(discoverScore).toMatch(/^Match \d+ of 100$/)
    await click(buttons('Saved')[0])
    expect(navigation.navigate).toHaveBeenCalledWith('jobs', { tab: 'saved', openId: saved.id })
    expect(currentTab()).toBe('saved')
    // The Saved row and the drawer show the Discover number, not the relevance.
    expect(badge('Saved jobs')).toBe(discoverScore)
    const drawer = document.body.querySelector('[role="dialog"]')
    expect(drawer?.textContent).toContain('Software Engineer, New Grad')
    expect(drawer?.querySelector(`[aria-label="${discoverScore}"]`)).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/scent/i)
  })

  it('a tab navigation that names no job (⌘K) does not reopen the drawer seen before', async () => {
    const saved = toJob(row, new Date())
    state.saved = [saved]
    await open({ tab: 'saved', openId: saved.id })
    const drawer = () => document.body.querySelector('[role="dialog"]')
    expect(drawer()?.textContent).toContain('Software Engineer, New Grad')
    // The palette's "Jobs → Discover", then "Jobs → Saved": the page stays mounted.
    await open({ tab: 'discover' })
    expect(currentTab()).toBe('discover')
    await open({ tab: 'saved' })
    expect(currentTab()).toBe('saved')
    expect(drawer()).toBeNull()
  })

  it('stays on Discover after saving the first job there', async () => {
    await open()
    expect(currentTab()).toBe('discover')
    await click(buttons('Save')[0])
    expect(currentTab()).toBe('discover')
    expect(buttons('Saved')).toHaveLength(1)
    expect(container.textContent).toContain('Saved (1)')
  })
})
