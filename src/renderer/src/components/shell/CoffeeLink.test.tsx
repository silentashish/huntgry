// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { COFFEE_URL, NUDGE_FORCE_KEY, NUDGE_RULES, NUDGE_STORAGE_KEY, nudgeDelay, parseNudgeState, type NudgeState } from './coffee'
import { CoffeeLink } from './CoffeeLink'
import { resetCoffeeSession } from './useCoffeeNudge'

/**
 * The sidebar's "Buy me a coffee" link (#185): an external link with an accessible name, and the nudge
 * bubble that only shows when the schedule allows, never takes focus, and backs off once closed.
 */

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 26, 9)

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  localStorage.clear()
  resetCoffeeSession()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const stored = (): NudgeState | null => parseNudgeState(localStorage.getItem(NUDGE_STORAGE_KEY))
const seed = (state: NudgeState) => localStorage.setItem(NUDGE_STORAGE_KEY, JSON.stringify(state))
const mount = () => act(() => root.render(<CoffeeLink />))
const bubble = () => container.querySelector('[role="status"]')?.textContent ?? ''
const link = () => container.querySelector('a')!
const dismissButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss coffee reminder"]')
const item = () => container.firstElementChild as HTMLElement
/** The pointer moves onto / off the item (React builds mouseenter / mouseleave from mouseover / mouseout). */
const pointerIn = () => act(() => item().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
const pointerOut = () => act(() => item().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
/** To the moment the nudge is tried in this session (`Math.random` is 0.5). */
const DELAY = nudgeDelay(0.5)
const waitForTry = () => act(() => vi.advanceTimersByTime(DELAY - (Date.now() - NOW)))

describe('Buy me a coffee', () => {
  it('links to the Buy Me a Coffee page in a new window, with an accessible name', () => {
    mount()
    expect(link().getAttribute('href')).toBe(COFFEE_URL)
    expect(link().getAttribute('target')).toBe('_blank')
    expect(link().getAttribute('rel')).toBe('noreferrer')
    expect(link().getAttribute('aria-label')).toBe('Buy me a coffee (opens in your browser)')
    expect(link().textContent).toBe('Buy me a coffee')
  })

  it('counts the launch and never nudges on the first one', () => {
    mount()
    expect(stored()).toEqual({ firstSeenAt: NOW, launches: 1, lastNudgeAt: null, lastEngagedAt: null })
    waitForTry()
    expect(bubble()).toBe('')
    expect(link().hasAttribute('data-nudge')).toBe(false)
  })

  it('nudges a settled user once, well into the session, without taking focus, then fades out', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    const before = document.activeElement
    mount()
    act(() => vi.advanceTimersByTime(NUDGE_RULES.minSessionMs - 1))
    expect(bubble()).toBe('')
    waitForTry()
    expect(bubble()).toContain('Enjoying Huntgry?')
    expect(link().getAttribute('data-nudge')).toBe('true')
    expect(document.activeElement).toBe(before)
    expect(stored()).toMatchObject({ launches: 5, lastNudgeAt: expect.any(Number), lastEngagedAt: null })

    act(() => vi.advanceTimersByTime(NUDGE_RULES.bubbleMs + 1_000))
    expect(bubble()).toBe('')
    expect(stored()?.lastEngagedAt).toBeNull()
  })

  it('backs off for longer once the bubble is closed', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    mount()
    waitForTry()
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss coffee reminder"]')!
    act(() => close.click())
    expect(bubble()).toBe('')
    expect(stored()?.lastEngagedAt).toBe(Date.now())
  })

  it('records a click on the link', () => {
    mount()
    // jsdom does not open windows; the click handler still runs.
    act(() => link().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(stored()?.lastEngagedAt).toBe(Date.now())
  })

  it('plays right away when forced, whatever the schedule', () => {
    localStorage.setItem(NUDGE_FORCE_KEY, '1')
    mount()
    act(() => vi.advanceTimersByTime(2_000))
    expect(bubble()).toContain('Enjoying Huntgry?')
  })

  it('keeps a click in memory when it cannot be saved, so the pending nudge does not play', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    mount()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    act(() => link().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    waitForTry()
    expect(bubble()).toBe('')
  })

  it('keeps a played nudge in memory when it cannot be saved, so a remounted sidebar does not play it again', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    mount()
    waitForTry()
    expect(bubble()).toContain('Enjoying Huntgry?')
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    // The moment for this session has passed, so the remounted sidebar tries right away.
    act(() => vi.advanceTimersByTime(0))
    expect(bubble()).toBe('')
  })

  it('keeps the bubble up while focus is in it, even after the pointer leaves', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    mount()
    waitForTry()
    pointerIn()
    act(() => dismissButton()!.focus())
    pointerOut()
    act(() => vi.advanceTimersByTime(NUDGE_RULES.bubbleMs + 1_000))
    expect(bubble()).toContain('Enjoying Huntgry?')
    expect(document.activeElement).toBe(dismissButton())
  })

  it('keeps the bubble up while the pointer is on it, even after focus leaves', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    mount()
    waitForTry()
    act(() => dismissButton()!.focus())
    pointerIn()
    act(() => dismissButton()!.blur())
    act(() => vi.advanceTimersByTime(NUDGE_RULES.bubbleMs + 1_000))
    expect(bubble()).toContain('Enjoying Huntgry?')
    pointerOut()
    act(() => vi.advanceTimersByTime(1_000))
    expect(bubble()).toBe('')
  })

  it('brings a fading bubble back when focus moves into it, and fades it once focus leaves', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    mount()
    waitForTry()
    act(() => vi.advanceTimersByTime(NUDGE_RULES.bubbleMs + 100))
    expect(container.querySelector('[data-leaving]')).not.toBeNull()
    act(() => dismissButton()!.focus())
    act(() => vi.advanceTimersByTime(1_000))
    expect(bubble()).toContain('Enjoying Huntgry?')
    expect(container.querySelector('[data-leaving]')).toBeNull()
    expect(document.activeElement).toBe(dismissButton())

    act(() => dismissButton()!.blur())
    act(() => vi.advanceTimersByTime(1_000))
    expect(bubble()).toBe('')
  })

  it('puts focus back on the link when the focused close button is pressed or Escape closes the bubble', () => {
    seed({ firstSeenAt: NOW - 10 * DAY, launches: 4, lastNudgeAt: null, lastEngagedAt: null })
    mount()
    waitForTry()
    act(() => dismissButton()!.focus())
    act(() => dismissButton()!.click())
    expect(bubble()).toBe('')
    expect(document.activeElement).toBe(link())

    resetCoffeeSession()
    localStorage.setItem(NUDGE_FORCE_KEY, '1')
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    act(() => vi.advanceTimersByTime(2_000))
    act(() => dismissButton()!.focus())
    act(() => dismissButton()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(bubble()).toBe('')
    expect(document.activeElement).toBe(link())
  })

  it('leaves focus alone when the bubble is closed while focus is elsewhere', () => {
    localStorage.setItem(NUDGE_FORCE_KEY, '1')
    const outside = document.createElement('button')
    document.body.append(outside)
    mount()
    act(() => vi.advanceTimersByTime(2_000))
    outside.focus()
    act(() => dismissButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(bubble()).toBe('')
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
