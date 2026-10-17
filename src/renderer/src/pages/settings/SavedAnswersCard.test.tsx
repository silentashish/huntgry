// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedAnswers } from '@shared/apply-types'
import { NavigationContext, type Navigation } from '../../navigation'

/**
 * Settings → Saved application answers (#71): sensitive values masked until shown; facts edited in place
 * (#136); Forget / Forget all; a link to Profile → Application details.
 */

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
  setFact: vi.fn(async (_fact: string, value: string) => ({
    ...saved,
    facts: [{ ...saved.facts[0], value }, ...saved.facts.slice(1)]
  })),
  forgetAllAnswers: vi.fn(async () => empty),
  pickSetting: vi.fn(async () => true),
  setPickSetting: vi.fn(async (on: boolean) => on),
  aiAnswersSetting: vi.fn(async () => true),
  setAiAnswersSetting: vi.fn(async (on: boolean) => on)
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

const navigate = vi.fn()
const nav: Navigation = { location: { page: 'settings', params: undefined }, navigate, setLeaveGuard: () => undefined }

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
          <NavigationContext.Provider value={nav}>
            <SavedAnswersCard />
          </NavigationContext.Provider>
        </MantineProvider>
      )
    )
    expect(container.textContent).toContain('Needs visa sponsorship')
    const sponsorship = container.querySelector<HTMLSelectElement>('select[aria-label="Needs visa sponsorship"]')!
    expect(sponsorship.value).toBe('no')
    expect(container.textContent).toContain('The mission.')
    expect(container.querySelector('input[aria-label="Gender"]')).toBeNull()
    await act(async () => button('Show Gender').click())
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Gender"]')!.value).toBe('Female')

    // A fact is edited in place, through the same store as the Apply panel.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sponsorship, 'yes')
      sponsorship.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(apply.setFact).toHaveBeenCalledWith('needsSponsorship', 'yes')
    expect(sponsorship.value).toBe('yes')

    // Every one-time answer is set up front in Profile.
    await act(async () => button('Edit in Profile → Application details').click())
    expect(navigate).toHaveBeenCalledWith('profile', { view: 'editor', section: 'application' })

    await act(async () => button('Forget Gender').click())
    expect(apply.forgetAnswer).toHaveBeenCalledWith({ fact: 'gender' })
    expect(container.querySelector('input[aria-label="Gender"]')).toBeNull()

    // "Pick dropdown answers automatically": on by default, saved when turned off.
    const pick = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) =>
      (i.closest('.mantine-Switch-root')?.textContent ?? '').includes('Pick dropdown answers automatically')
    )!
    expect(pick.checked).toBe(true)
    await act(async () => pick.click())
    expect(apply.setPickSetting).toHaveBeenCalledWith(false)
    expect(pick.checked).toBe(false)

    // "Use AI to answer unknown questions" (#136): on by default, saved when turned off.
    const ai = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) =>
      (i.closest('.mantine-Switch-root')?.textContent ?? '').includes('Use AI to answer unknown questions')
    )!
    expect(ai.checked).toBe(true)
    await act(async () => ai.click())
    expect(apply.setAiAnswersSetting).toHaveBeenCalledWith(false)
    expect(ai.checked).toBe(false)

    await act(async () => button('Forget all').click())
    await act(async () => button('Forget all').click())
    expect(apply.forgetAllAnswers).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('None yet.')
  })
})
