// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedAnswers } from '@shared/apply-types'

/** Settings → Saved application answers (#71): sensitive values masked until shown; Forget / Forget all. */

const saved: SavedAnswers = {
  facts: [
    { fact: 'needsSponsorship', label: 'Needs visa sponsorship', sensitive: false, value: 'no', updatedAt: '2026-10-06T00:00:00.000Z' },
    { fact: 'gender', label: 'Gender', sensitive: true, value: 'Female', updatedAt: '2026-10-06T00:00:00.000Z' }
  ],
  questions: [{ question: 'text|why us|0', label: 'Why us?', value: 'The mission.', updatedAt: '2026-10-06T00:00:00.000Z' }]
}
const empty: SavedAnswers = { facts: [], questions: [] }
const apply = {
  answers: vi.fn(async () => saved),
  forgetAnswer: vi.fn(async () => ({ ...saved, facts: saved.facts.slice(0, 1) })),
  forgetAllAnswers: vi.fn(async () => empty)
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, { huntgry: { apply, on: () => () => undefined } })
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const button = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

describe('SavedAnswersCard', () => {
  it('masks sensitive answers until shown, and forgets one or all', async () => {
    const { SavedAnswersCard } = await import('./SavedAnswersCard')
    await act(async () =>
      root.render(
        <MantineProvider>
          <SavedAnswersCard />
        </MantineProvider>
      )
    )
    expect(container.textContent).toContain('Needs visa sponsorship')
    expect(container.textContent).toContain('No')
    expect(container.textContent).toContain('The mission.')
    expect(container.textContent).not.toContain('Female')
    await act(async () => button('Show Gender').click())
    expect(container.textContent).toContain('Female')

    await act(async () => button('Forget Gender').click())
    expect(apply.forgetAnswer).toHaveBeenCalledWith({ fact: 'gender' })
    expect(container.textContent).not.toContain('Female')

    await act(async () => button('Forget all').click())
    await act(async () => button('Forget all').click())
    expect(apply.forgetAllAnswers).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('None yet.')
  })
})
