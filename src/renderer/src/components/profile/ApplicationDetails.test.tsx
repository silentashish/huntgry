// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FACT_KEYS, FACTS, type FactKey } from '@shared/apply-facts'
import type { SavedAnswers } from '@shared/apply-types'

/** Profile → Application details (#136): every fact, grouped, saved as it changes, profile seeds as placeholders. */

const saved: SavedAnswers = {
  facts: [
    { fact: 'needsSponsorship', label: 'Needs visa sponsorship', sensitive: false, value: 'yes', updatedAt: '2026-10-17T00:00:00.000Z' },
    { fact: 'gender', label: 'Gender', sensitive: true, value: 'decline', updatedAt: '2026-10-17T00:00:00.000Z' }
  ],
  questions: [],
  seeds: { visaStatus: 'H-1B', workAuthorized: 'yes', needsSponsorship: 'yes' }
}

const withFact = (fact: FactKey, value: string): SavedAnswers => ({
  ...saved,
  facts: [...saved.facts.filter((f) => f.fact !== fact), { fact, label: FACTS[fact].label, sensitive: FACTS[fact].sensitive, value, updatedAt: '' }]
})

const apply = {
  answers: vi.fn(async () => saved),
  setFact: vi.fn(async (fact: FactKey, value: string) => withFact(fact, value))
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
  apply.setFact.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/** The input or select labelled `label`. */
function control<T extends HTMLElement = HTMLInputElement>(label: string): T {
  const el = [...container.querySelectorAll('label')].find((l) => l.textContent?.replace(/\s*\*$/, '') === label)
  if (!el) throw new Error(`no field "${label}"`)
  return document.getElementById(el.htmlFor) as T
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function choose(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

async function render() {
  const { ApplicationDetails } = await import('./ApplicationDetails')
  await act(async () =>
    root.render(
      <MantineProvider>
        <ApplicationDetails />
      </MantineProvider>
    )
  )
}

describe('ApplicationDetails', () => {
  it('lists every fact once, in four groups, with the sensitive note on self-identification', async () => {
    const { FACT_GROUPS } = await import('./ApplicationDetails')
    expect(FACT_GROUPS.flatMap((g) => g.facts).sort()).toEqual([...FACT_KEYS].sort())
    await render()
    for (const key of FACT_KEYS) expect(control(FACTS[key].label)).toBeTruthy()
    for (const title of ['Work eligibility', 'Availability & pay', 'About you', 'Voluntary self-identification']) {
      expect(container.querySelector(`section[aria-label="${title}"]`)).not.toBeNull()
    }
    const sensitive = container.querySelector('section[aria-label="Voluntary self-identification"]')!
    expect(sensitive.textContent).toContain('never sent to the AI model')
    expect(container.textContent).toContain(`2 of ${FACT_KEYS.length} set`)
  })

  it('shows stored values, and the profile seeds as placeholders where nothing is stored', async () => {
    await render()
    expect(control<HTMLSelectElement>('Needs visa sponsorship').value).toBe('yes')
    // A choice stored as "decline" reads as the usual wording.
    expect(control('Gender').value).toBe('Decline to self-identify')
    const visa = control('Work authorization status / visa type')
    expect(visa.value).toBe('')
    expect(visa.placeholder).toBe('From your profile: H-1B')
    // The suggestions list is attached.
    expect(document.getElementById(visa.getAttribute('list')!)?.querySelectorAll('option').length).toBe(11)
    const authorized = control<HTMLSelectElement>('Authorized to work')
    expect(authorized.value).toBe('')
    expect(authorized.options[0].textContent).toBe('From your profile: Yes')
    expect([...authorized.options].map((o) => o.textContent).slice(1)).toEqual(['Yes', 'No', 'Prefer not to say'])
  })

  it('saves a yes/no at once and typed text on blur, then says so', async () => {
    await render()
    await act(async () => choose(control<HTMLSelectElement>('18 or older'), 'yes'))
    expect(apply.setFact).toHaveBeenCalledWith('over18', 'yes')
    expect(control<HTMLSelectElement>('18 or older').value).toBe('yes')

    const years = control('Years of experience')
    await act(async () => type(years, '6'))
    await act(async () => years.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(apply.setFact).toHaveBeenCalledWith('yearsExperience', '6')
    expect(container.textContent).toContain('Saved')

    // Clearing a select forgets the fact.
    await act(async () => choose(control<HTMLSelectElement>('Needs visa sponsorship'), ''))
    expect(apply.setFact).toHaveBeenLastCalledWith('needsSponsorship', '')
  })

  it('saves typed text after a short pause, once', async () => {
    await render()
    const heard = control('How did you hear about us')
    await act(async () => {
      type(heard, 'Linked')
      type(heard, 'LinkedIn')
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(apply.setFact).toHaveBeenCalledTimes(1)
    expect(apply.setFact).toHaveBeenCalledWith('howHeard', 'LinkedIn')
    // Blur after the save: nothing new to save.
    await act(async () => heard.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(apply.setFact).toHaveBeenCalledTimes(1)
  })

  it('shows a refused save under the field', async () => {
    apply.setFact.mockRejectedValueOnce(new Error('Answer too long.'))
    await render()
    const salary = control('Salary expectation')
    await act(async () => type(salary, '$150k'))
    await act(async () => salary.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(container.textContent).toContain('Answer too long.')
  })
})
