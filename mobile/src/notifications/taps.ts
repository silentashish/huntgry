/**
 * What a tap on a push does (#39): open the screen for its `data.category` and fetch the
 * content over the encrypted channel (the push carries nothing else). A tap on "A run needs
 * your reply" opens the Queue first and moves on to the run as soon as the phone knows which
 * one waits. Plain TypeScript, unit-tested with a fake model and clock.
 */

import { categoryOf, routeFor, type RouteContext } from './categories'
import { systemClock, type Clock } from '../remote/platform'

export interface TapModel {
  getSnapshot(): RouteContext & { phase: 'loading' | 'unpaired' | 'paired' }
  subscribe(listener: () => void): () => void
  /** Reconnect now (the app was in the background; the socket is likely gone). */
  wake(): void
  refreshStatus(): void
  refreshQueue(): void
}

export interface TapRouterOptions {
  model: TapModel
  /**
   * Opens `href`; false when the navigator is not mounted yet (a cold start). The tap then
   * waits for `navigatorReady()` or the next model change and tries again.
   */
  navigate(href: string): boolean
  clock?: Clock
  /** How long a "needs reply" tap may still move on to the run once it is known. */
  settleMs?: number
}

const HANDLED_LIMIT = 50

export class TapRouter {
  private readonly handled = new Set<string>()
  private cancelPending: (() => void) | null = null
  private retryPending: (() => void) | null = null
  private readonly clock: Clock

  constructor(private readonly o: TapRouterOptions) {
    this.clock = o.clock ?? systemClock
  }

  /**
   * A tapped notification (`id` dedupes the cold-start response and the listener reporting the
   * same tap). Returns false for a payload without a known category or a phone that is not
   * paired (the Pair screen stays).
   */
  open(id: string, data: unknown): boolean {
    const category = categoryOf(data)
    if (!category || this.handled.has(id)) return false
    this.handled.add(id)
    if (this.handled.size > HANDLED_LIMIT) this.handled.delete(this.handled.values().next().value as string)
    this.cancel()

    const { model, navigate } = this.o
    const phase = model.getSnapshot().phase
    if (phase === 'unpaired') return false

    let timer: unknown = null
    let unsubscribe: (() => void) | null = null
    let started = false
    let last: string | null = null
    /** True once `href` is on screen (now or by an earlier step). */
    const go = (href: string): boolean => {
      if (href === last) return true
      if (!navigate(href)) return false
      last = href
      return true
    }
    const finish = () => {
      unsubscribe?.()
      unsubscribe = null
      if (timer !== null) this.clock.clearTimeout(timer)
      timer = null
      if (this.cancelPending === finish) this.cancelPending = null
      if (this.retryPending === step) this.retryPending = null
    }
    const step = () => {
      const snap = model.getSnapshot()
      if (snap.phase === 'unpaired') return finish()
      if (snap.phase !== 'paired') return
      if (!started) {
        started = true
        model.wake()
        model.refreshStatus()
        model.refreshQueue()
      }
      const route = routeFor(category, snap)
      if (go(route.href) && route.settled) finish()
    }
    this.cancelPending = finish
    this.retryPending = step
    unsubscribe = model.subscribe(step)
    timer = this.clock.setTimeout(finish, this.o.settleMs ?? 15_000)
    step()
    return true
  }

  /** The navigator just mounted: a tap that could not navigate yet tries again. */
  navigatorReady(): void {
    this.retryPending?.()
  }

  /** Stops waiting for a better screen (another tap, the owner navigated, unmount). */
  cancel(): void {
    this.cancelPending?.()
  }
}
