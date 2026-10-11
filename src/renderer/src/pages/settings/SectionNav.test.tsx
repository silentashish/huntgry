// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { activeSection } from './SectionNav'

/** Settings (#116): which section the nav highlights, and the Appearance card's System / Light / Dark. */

describe('activeSection', () => {
  const ids = ['agents', 'pricing', 'remote', 'appearance'] as const

  it('is the first section before any has reached the reading line', () => {
    expect(activeSection(ids, [300, 900, 1500, 2000], 140, false)).toBe('agents')
  })

  it('is the last section whose top passed the reading line', () => {
    expect(activeSection(ids, [-800, -20, 400, 900], 140, false)).toBe('pricing')
    expect(activeSection(ids, [-800, -400, 140, 700], 140, false)).toBe('remote')
  })

  it('is the last section once the page is scrolled to the bottom', () => {
    expect(activeSection(ids, [-1600, -900, -100, 500], 140, true)).toBe('appearance')
  })

  it('skips sections that are not rendered', () => {
    expect(activeSection(ids, [null, null, 600, 900], 140, false)).toBe('remote')
    expect(activeSection(ids, [-500, 100, null, null], 140, true)).toBe('pricing')
    expect(activeSection(ids, [null, null, null, null], 140, false)).toBeNull()
  })
})

describe('AppearanceCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  })
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const option = (label: string): HTMLElement => {
    const el = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.trim() === label)
    if (!el) throw new Error(`no option "${label}"`)
    return el
  }

  it('shows the stored preference and switches the colour scheme', async () => {
    const { AppearanceCard } = await import('./AppearanceCard')
    await act(async () =>
      root.render(
        <MantineProvider defaultColorScheme="auto">
          <AppearanceCard />
        </MantineProvider>
      )
    )
    expect(option('System').getAttribute('aria-checked')).toBe('true')
    expect(option('Dark').getAttribute('aria-checked')).toBe('false')

    await act(async () => option('Dark').click())
    expect(option('Dark').getAttribute('aria-checked')).toBe('true')
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark')

    await act(async () => option('Light').click())
    expect(option('Light').getAttribute('aria-checked')).toBe('true')
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light')
  })
})
