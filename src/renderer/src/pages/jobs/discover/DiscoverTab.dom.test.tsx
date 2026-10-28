// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toJob } from '@shared/explore-score'
import type { ExploreJob, ExploreList } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'

/**
 * Jobs → Discover in a DOM (#169, #189; the Explore page): list and Refresh requests that overlap. The newest one wins, and when it
 * settles the loader and the Refresh spinner both go, whichever request started them. And the rows' match score
 * badges (#150): exact from the qualifications, "≈" from the title, details on focus, Match ≥ N and the sort.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve(v: T): void
  reject(e: unknown): void
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const calls = { list: [] as { category: string; d: Deferred<ExploreList> }[], refresh: [] as { category: string; d: Deferred<ExploreList> }[] }

/** A master profile: a Backend Engineer with these skills. */
const profileWith = (skills: string[]) => {
  const p = emptyProfile()
  p.contact.headline = 'Backend Engineer'
  p.skills = [{ category: 'Languages', items: skills }]
  return p
}
/** What `api.profile.read` answers (Go and Python unless a test edits it), and how often it was read. */
const profileState = { profile: profileWith(['Go', 'Python']), reads: 0 }

vi.mock('../../../api', () => ({
  api: {
    jobs: { list: async () => [] },
    profile: {
      read: async () => {
        profileState.reads++
        return { profile: profileState.profile }
      }
    },
    explore: {
      account: async () => ({ connected: true, checkedAt: null }),
      list: (category: string) => {
        const d = deferred<ExploreList>()
        calls.list.push({ category, d })
        return d.promise
      },
      refresh: (category: string) => {
        const d = deferred<ExploreList>()
        calls.refresh.push({ category, d })
        return d.promise
      },
      add: async () => {
        throw new Error('not used')
      }
    }
  },
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
vi.mock('../../../navigation', () => ({ useNavigation: () => ({ navigate: () => undefined }) }))

const { DiscoverTab } = await import('./DiscoverTab')

/** What the page gives the tab: the saved jobs, and what was saved or opened. */
const page = { saved: [] as Job[], onSaved: vi.fn(), onOpenSaved: vi.fn() }
const tab = () => (
  <DiscoverTab
    saved={page.saved}
    onSaved={page.onSaved}
    onOpenSaved={page.onOpenSaved}
    header={(h) => (
      <header>
        {h.eyebrow}
        {h.actions}
      </header>
    )}
  />
)

const today = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()
const job = (title: string, qualifications?: string): ExploreJob => ({
  id: `aaaaaa${title.length}${title.charCodeAt(0)}`,
  company: 'Northwind',
  companyUrl: null,
  title,
  url: `https://jobright.ai/jobs/info/aaaaaa${title.length}${title.charCodeAt(0)}`,
  location: 'Seattle',
  workModel: 'Remote',
  postedAt: today,
  ...(qualifications !== undefined ? { qualifications } : {})
})
const listOf = (category: string, ...titles: string[]): ExploreList => ({
  jobs: titles.map((t) => job(t)),
  fetchedAt: new Date().toISOString(),
  category,
  source: 'api'
})

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => undefined
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  calls.list.length = 0
  calls.refresh.length = 0
  profileState.profile = profileWith(['Go', 'Python'])
  profileState.reads = 0
  localStorage.clear()
  page.saved = []
  page.onSaved.mockReset()
  page.onOpenSaved.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root.render(
      <MantineProvider env="test">
        {tab()}
      </MantineProvider>
    )
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const loader = () => container.querySelector('[aria-label="Loading the Jobright list"]')
const titles = () => [...container.querySelectorAll('[aria-label="Jobright jobs"] li')].map((li) => li.getAttribute('aria-label'))
const refreshButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Refresh')!
const spinning = () => refreshButton().hasAttribute('data-loading')
const settle = async (fn: () => void) => {
  await act(async () => {
    fn()
    await Promise.resolve()
  })
}

describe('Explore requests that overlap', () => {
  it('Refresh during the first load: its answer shows and the loader goes, whatever the load does later', async () => {
    expect(loader()).not.toBeNull()
    await settle(() => refreshButton().click())
    expect(calls.refresh).toHaveLength(1)
    await settle(() => calls.refresh[0].d.resolve(listOf('newgrad:us:swe', 'From refresh')))
    expect(loader()).toBeNull()
    expect(spinning()).toBe(false)
    expect(titles()).toEqual(['From refresh at Northwind'])
    // The superseded load answers late: nothing changes.
    await settle(() => calls.list[0].d.resolve(listOf('newgrad:us:swe', 'Stale load')))
    expect(loader()).toBeNull()
    expect(titles()).toEqual(['From refresh at Northwind'])
  })

  it('Refresh during the first load that fails: the error shows, not an endless loader', async () => {
    await settle(() => refreshButton().click())
    await settle(() => calls.refresh[0].d.reject(new Error('The newgrad-jobs API answered HTTP 500 for the Jobright jobs.')))
    expect(loader()).toBeNull()
    expect(container.textContent).toContain('The newgrad-jobs API answered HTTP 500')
    expect(container.textContent).toContain('No jobs to discover yet')
    await settle(() => calls.list[0].d.reject(new Error('stale')))
    expect(container.textContent).not.toContain('stale')
  })

  it('a category picked while a Refresh runs: its list shows, the old Refresh is dropped and stops spinning', async () => {
    await settle(() => calls.list[0].d.resolve(listOf('newgrad:us:swe', 'Cached')))
    await settle(() => refreshButton().click())
    expect(spinning()).toBe(true)
    await pick('Data Analysis')
    expect(calls.list.map((c) => c.category)).toEqual(['newgrad:us:swe', 'newgrad:us:data_analysis'])
    expect(spinning()).toBe(false)
    expect(loader()).not.toBeNull()
    await settle(() => calls.list[1].d.resolve(listOf('newgrad:us:data_analysis', 'Junior Data Analyst')))
    expect(loader()).toBeNull()
    expect(titles()).toEqual(['Junior Data Analyst at Northwind'])
    // The SWE refresh answers late: the page stays on Data Analysis.
    await settle(() => calls.refresh[0].d.resolve(listOf('newgrad:us:swe', 'Late refresh')))
    expect(titles()).toEqual(['Junior Data Analyst at Northwind'])
    expect(spinning()).toBe(false)
  })

  it('Refresh during an uncached category switch: the refresh answer shows and the loader goes', async () => {
    await settle(() => calls.list[0].d.resolve(listOf('newgrad:us:swe', 'Cached')))
    await pick('Data Analysis')
    expect(loader()).not.toBeNull()
    await settle(() => refreshButton().click())
    expect(calls.refresh.map((c) => c.category)).toEqual(['newgrad:us:data_analysis'])
    await settle(() => calls.refresh[0].d.resolve(listOf('newgrad:us:data_analysis', 'Refreshed analyst')))
    expect(loader()).toBeNull()
    expect(titles()).toEqual(['Refreshed analyst at Northwind'])
    await settle(() => calls.list[1].d.resolve(listOf('newgrad:us:data_analysis', 'Stale analyst')))
    expect(titles()).toEqual(['Refreshed analyst at Northwind'])
  })
})

/** Picks a category in the Mantine Select (its options render in a portal on `document.body`). */
async function pick(label: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Category"]')!
  await settle(() => input.click())
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === label)
  if (!option) throw new Error(`No option ${label}`)
  await settle(() => (option as HTMLElement).click())
}

describe('Match score badges (#150)', () => {
  const badges = () => [...container.querySelectorAll('[aria-label="Jobright jobs"] li [role="img"]')].map((b) => b.getAttribute('aria-label'))
  const scored: ExploreList = {
    jobs: [
      job('Frontend Developer', '1. Experience with Go, Java and React.'),
      job('Backend Engineer I', '1. Experience with Go and Python.'),
      job('Data Wrangler', '1. Experience with Python, Java, Kotlin and Scala.')
    ],
    fetchedAt: new Date().toISOString(),
    category: 'newgrad:us:swe',
    source: 'api'
  }
  const typeMinMatch = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Min. match"]')!
    await settle(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('shows the exact score of each API row, and its matched and missing skills on focus', async () => {
    await settle(() => calls.list[0].d.resolve(scored))
    expect(badges()).toEqual(['Match 33 of 100', 'Match 100 of 100', 'Match 25 of 100'])
    expect(container.textContent).not.toContain('≈')
    const badge = container.querySelector<HTMLElement>('[aria-label="Match 33 of 100"]')!
    await act(async () => {
      badge.focus()
      await new Promise((r) => setTimeout(r, 250))
    })
    const tip = document.body.textContent ?? ''
    expect(tip).toContain('You have: Go')
    expect(tip).toContain('Missing: Java, React')
  })

  it('gives a README row a title-only "≈" estimate and says so', async () => {
    await settle(() => calls.list[0].d.resolve({ ...listOf('newgrad:us:swe', 'Backend Engineer'), source: 'readme' }))
    const [label] = badges()
    expect(label).toMatch(/^Match about \d+ of 100, a title-only estimate$/)
    expect(container.querySelector('[data-kind="estimate"]')?.textContent).toMatch(/^≈\d+/)
    const badge = container.querySelector<HTMLElement>('[data-kind="estimate"]')!
    await act(async () => {
      badge.focus()
      await new Promise((r) => setTimeout(r, 250))
    })
    expect(document.body.textContent).toContain('a title-only estimate')
    expect(document.body.textContent).toContain('Title: Backend Engineer')
  })

  it('sorts by match and filters by Match ≥ N, on top of the day and text filters', async () => {
    await settle(() => calls.list[0].d.resolve(scored))
    await typeMinMatch('30')
    expect(titles()).toEqual(['Frontend Developer at Northwind', 'Backend Engineer I at Northwind'])
    await pickOption('Sort', 'Best match')
    expect(titles()).toEqual(['Backend Engineer I at Northwind', 'Frontend Developer at Northwind'])
    await typeMinMatch('')
    expect(titles()).toEqual(['Backend Engineer I at Northwind', 'Frontend Developer at Northwind', 'Data Wrangler at Northwind'])
  })
})

describe('Match scores follow the master profile (#150)', () => {
  const badges = () => [...container.querySelectorAll('[aria-label="Jobright jobs"] li [role="img"]')].map((b) => b.getAttribute('aria-label'))
  const cached: ExploreList = {
    jobs: [job('Frontend Developer', '1. Experience with Go, Java and React.'), job('Data Wrangler', '1. Experience with Python, Java, Kotlin and Scala.')],
    fetchedAt: new Date().toISOString(),
    category: 'newgrad:us:swe',
    source: 'api'
  }
  const remount = () =>
    act(() => {
      root.unmount()
      root = createRoot(container)
      root.render(
        <MantineProvider env="test">
          {tab()}
        </MantineProvider>
      )
    })

  it('re-scores the same cached rows after the profile is edited and Explore is opened again', async () => {
    await settle(() => calls.list[0].d.resolve(cached))
    expect(badges()).toEqual(['Match 33 of 100', 'Match 25 of 100'])
    await pickOption('Sort', 'Best match')
    expect(titles()).toEqual(['Frontend Developer at Northwind', 'Data Wrangler at Northwind'])

    // The profile gains Java, Kotlin and Scala (edited on the Profile page; leaving Explore unmounts it).
    profileState.profile = profileWith(['Go', 'Python', 'Java', 'Kotlin', 'Scala'])
    remount()
    expect(calls.list).toHaveLength(2)
    await settle(() => calls.list[1].d.resolve(cached))
    expect(profileState.reads).toBe(2)
    // Only the list read from the cache and the profile: no refresh, nothing else per row.
    expect(calls.refresh).toHaveLength(0)
    expect(badges()).toEqual(['Match 67 of 100', 'Match 100 of 100'])

    const badge = container.querySelector<HTMLElement>('[aria-label="Match 100 of 100"]')!
    await act(async () => {
      badge.focus()
      await new Promise((r) => setTimeout(r, 250))
    })
    expect(document.body.textContent).toContain('You have: Java, Kotlin, Python, Scala')
    await act(async () => badge.blur())

    // Best match and Match ≥ N use the new scores.
    await pickOption('Sort', 'Best match')
    expect(titles()).toEqual(['Data Wrangler at Northwind', 'Frontend Developer at Northwind'])
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Min. match"]')!
    await settle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '70')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(titles()).toEqual(['Data Wrangler at Northwind'])
  })
})

/** Picks an option of the Mantine Select labelled `aria` (its options render in a portal on `document.body`). */
async function pickOption(aria: string, label: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${aria}"]`)!
  await settle(() => input.click())
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === label)
  if (!option) throw new Error(`No option ${label}`)
  await settle(() => (option as HTMLElement).click())
}

describe('A saved row (#189)', () => {
  const row = job('Backend Engineer I', '1. Experience with Go and Python.')
  const list: ExploreList = { jobs: [row, job('Data Wrangler')], fetchedAt: new Date().toISOString(), category: 'newgrad:us:swe', source: 'api' }
  const rerender = () => act(() => root.render(<MantineProvider env="test">{tab()}</MantineProvider>))
  const button = (name: string) => [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name)

  it('reads "Saved" with a check and opens its saved job on the Saved tab', async () => {
    const saved = toJob(row, new Date())
    page.saved = [saved]
    rerender()
    await settle(() => calls.list[0].d.resolve(list))
    expect(button('Saved')).toHaveLength(1)
    expect(button('Save')).toHaveLength(1)
    expect(container.textContent).not.toContain('Added')
    await settle(() => button('Saved')[0].click())
    expect(page.onOpenSaved).toHaveBeenCalledWith(saved)
  })

  it('shows the score of its saved job: a fetched full posting changes it on both tabs', async () => {
    page.saved = [{ ...toJob(row, new Date()), description: 'Go, Python, Java and Kotlin.' }]
    rerender()
    await settle(() => calls.list[0].d.resolve(list))
    const badges = [...container.querySelectorAll('[aria-label="Jobright jobs"] li [role="img"]')].map((b) => b.getAttribute('aria-label'))
    expect(badges[0]).toBe('Match 50 of 100')
  })
})
