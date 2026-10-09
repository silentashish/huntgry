import { describe, expect, it } from 'vitest'
import { FakeClock } from '../remote/test-helpers'
import type { RouteContext } from './categories'
import { TapRouter, type TapModel } from './taps'

type Snap = RouteContext & { phase: 'loading' | 'unpaired' | 'paired' }

class FakeModel implements TapModel {
  snap: Snap = { phase: 'paired', queue: null, runInfo: {} }
  readonly calls: string[] = []
  private readonly listeners = new Set<() => void>()
  getSnapshot = () => this.snap
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  set(patch: Partial<Snap>): void {
    this.snap = { ...this.snap, ...patch }
    for (const l of [...this.listeners]) l()
  }
  get listening(): number {
    return this.listeners.size
  }
  wake = () => void this.calls.push('wake')
  refreshStatus = () => void this.calls.push('status.get')
  refreshQueue = () => void this.calls.push('queue.get')
}

function setup() {
  const model = new FakeModel()
  const clock = new FakeClock()
  const visited: string[] = []
  const router = new TapRouter({ model, clock, navigate: (href) => void visited.push(href), settleMs: 15_000 })
  return { model, clock, visited, router }
}

const waiting = (runId: string) => ({ queue: { items: [{ runId, status: 'needs-reply', updatedAt: '2026-10-09T12:00:00.000Z' }] } })

describe('tapping a push', () => {
  it('opens the screen for its category and fetches fresh content over the socket', () => {
    const t = setup()
    expect(t.router.open('n1', { category: 'needs-review' })).toBe(true)
    expect(t.visited).toEqual(['/review'])
    expect(t.model.calls).toEqual(['wake', 'status.get', 'queue.get'])
    expect(t.model.listening).toBe(0)
  })

  it('opens the waiting run directly when the phone already knows it', () => {
    const t = setup()
    t.model.snap = { ...t.model.snap, ...waiting('run-7') }
    t.router.open('n1', { category: 'needs-reply' })
    expect(t.visited).toEqual(['/run/run-7'])
  })

  it('"needs reply": the Queue first, then the run once the queue arrives', () => {
    const t = setup()
    t.router.open('n1', { category: 'needs-reply' })
    expect(t.visited).toEqual(['/queue'])
    t.model.set({}) // an unrelated change navigates nowhere new
    expect(t.visited).toEqual(['/queue'])
    t.model.set(waiting('run-2'))
    expect(t.visited).toEqual(['/queue', '/run/run-2'])
    expect(t.model.listening).toBe(0)
  })

  it('stops waiting for the run after a while (the owner stays where they are)', async () => {
    const t = setup()
    t.router.open('n1', { category: 'needs-reply' })
    await t.clock.advance(15_000)
    expect(t.model.listening).toBe(0)
    t.model.set(waiting('run-2'))
    expect(t.visited).toEqual(['/queue'])
  })

  it('waits for a cold start to load the pairing before navigating', () => {
    const t = setup()
    t.model.snap = { ...t.model.snap, phase: 'loading' }
    t.router.open('n1', { category: 'pipeline-finished' })
    expect(t.visited).toEqual([])
    t.model.set({ phase: 'paired' })
    expect(t.visited).toEqual(['/'])
    expect(t.model.calls).toEqual(['wake', 'status.get', 'queue.get'])
  })

  it('does nothing on an unpaired phone, for an unknown payload, or for the same notification twice', () => {
    const t = setup()
    expect(t.router.open('n1', { category: 'spam' })).toBe(false)
    expect(t.router.open('n2', { category: 'failed' })).toBe(true)
    expect(t.router.open('n2', { category: 'failed' })).toBe(false) // cold-start response + listener
    t.model.snap = { ...t.model.snap, phase: 'unpaired' }
    expect(t.router.open('n3', { category: 'failed' })).toBe(false)
    expect(t.visited).toEqual(['/queue'])
  })

  it('a second tap replaces a pending one', () => {
    const t = setup()
    t.router.open('n1', { category: 'needs-reply' })
    t.router.open('n2', { category: 'usage-limit' })
    t.model.set(waiting('run-2'))
    expect(t.visited).toEqual(['/queue', '/'])
    expect(t.model.listening).toBe(0)
  })
})
