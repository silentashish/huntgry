import type { Adapter } from './adapters'

/**
 * Waiting for the page, from inside it (the tab's preload and jsdom tests).
 * Server-rendered React forms (Greenhouse) are in the DOM before `load`, but
 * hydration ~90 ms after `load` resets every value and file Huntgry wrote
 * before it (#63). The preload's isolated world cannot see React's own state,
 * so readiness is: `load` fired, then the DOM stayed quiet for a moment, then
 * the adapter's `ready` hook (if any) says the form is there. Every wait is
 * capped; a page that never settles is filled anyway and then verified.
 */

export interface ReadyOptions {
  /** How long the DOM must stay unchanged. */
  quietMs?: number
  /** The longest the whole wait may take. */
  maxMs?: number
}

export const QUIET_MS = 500
export const READY_MAX_MS = 6000

const viewOf = (doc: Document): Window & typeof globalThis => {
  const view = doc.defaultView
  if (!view) throw new Error('The page has no window.')
  return view as Window & typeof globalThis
}

export function sleep(doc: Document, ms: number): Promise<void> {
  const view = viewOf(doc)
  return new Promise((resolve) => view.setTimeout(resolve, ms))
}

/**
 * Resolves once `check()` is true (re-checked on every DOM change and every
 * 200 ms), or with false after `timeoutMs`.
 */
export function waitUntil(doc: Document, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const view = viewOf(doc)
  return new Promise((resolve) => {
    let done = false
    let busy = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      observer.disconnect()
      view.clearInterval(interval)
      view.clearTimeout(timer)
      resolve(value)
    }
    const run = async () => {
      if (done || busy) return
      busy = true
      try {
        if (await check()) finish(true)
      } catch {
        // A check that throws counts as "not yet".
      } finally {
        busy = false
      }
    }
    const observer = new view.MutationObserver(() => void run())
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    const interval = view.setInterval(() => void run(), 200)
    const timer = view.setTimeout(() => finish(false), timeoutMs)
    void run()
  })
}

/** Resolves after `load`, or right away when it already fired; false after `timeoutMs`. */
function loaded(doc: Document, timeoutMs: number): Promise<boolean> {
  if (doc.readyState === 'complete') return Promise.resolve(true)
  const view = viewOf(doc)
  return new Promise((resolve) => {
    const timer = view.setTimeout(() => resolve(false), timeoutMs)
    view.addEventListener(
      'load',
      () => {
        view.clearTimeout(timer)
        resolve(true)
      },
      { once: true }
    )
  })
}

/** Resolves once nothing in the DOM changed for `quietMs`; false when `timeoutMs` passes first. */
export function domQuiet(doc: Document, quietMs: number, timeoutMs: number): Promise<boolean> {
  const view = viewOf(doc)
  return new Promise((resolve) => {
    let quiet = 0
    const finish = (value: boolean) => {
      observer.disconnect()
      view.clearTimeout(quiet)
      view.clearTimeout(cap)
      resolve(value)
    }
    const restart = () => {
      view.clearTimeout(quiet)
      quiet = view.setTimeout(() => finish(true), quietMs)
    }
    const observer = new view.MutationObserver(restart)
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    const cap = view.setTimeout(() => finish(false), timeoutMs)
    restart()
  })
}

/**
 * Waits until the page is ready to fill: `load`, a quiet DOM, then
 * `adapter.ready`. Returns whether every step finished before `maxMs`
 * (false still means "fill and verify": the cap only bounds the wait).
 */
export async function waitForReady(doc: Document, adapter: () => Adapter, options: ReadyOptions = {}): Promise<boolean> {
  const quietMs = options.quietMs ?? QUIET_MS
  const maxMs = options.maxMs ?? READY_MAX_MS
  const started = Date.now()
  const left = () => Math.max(0, maxMs - (Date.now() - started))
  if (!(await loaded(doc, left()))) return false
  if (!(await domQuiet(doc, quietMs, left()))) return false
  // The adapter is chosen after the DOM settled: the markup that identifies it may render late.
  const ready = adapter().ready
  if (!ready) return true
  return waitUntil(doc, () => ready(doc), left())
}

/** Whether an element is shown: connected, and neither it nor an ancestor is `hidden` or `display: none`. */
export function isShown(el: Element): boolean {
  if (!el.isConnected) return false
  const view = el.ownerDocument.defaultView
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return false
    const style = view?.getComputedStyle(node)
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  }
  return true
}

/** Whether any element matching `selector` is shown. */
export function anyShown(doc: Document, selector: string): boolean {
  return Array.from(doc.querySelectorAll(selector)).some(isShown)
}
