// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RunSummary } from '@shared/runner-types'

/** Sidebar badges (#108): live runs from listRuns + `runner:run`, the review list re-read on changes. */

const listeners = new Map<string, Set<(payload: unknown) => void>>()
const emit = (channel: string, payload?: unknown) => listeners.get(channel)?.forEach((l) => l(payload))
const run = (id: string, status: RunSummary['status']) => ({ id, status }) as RunSummary

const api = {
  runner: { listRuns: vi.fn(async () => [run('a', 'waiting'), run('b', 'running'), run('c', 'finished')]) },
  review: { list: vi.fn(async () => [{ applicationId: 'x' }, { applicationId: 'y' }]) },
  on: (channel: string, listener: (payload: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set()
    set.add(listener)
    listeners.set(channel, set)
    return () => set.delete(listener)
  }
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, { huntgry: api })
})

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
})

describe('useNavCounts', () => {
  it('counts waiting and running runs and the results waiting for review, and follows changes', async () => {
    const { useNavCounts } = await import('./useNavCounts')
    let counts = { waiting: 0, running: 0, review: 0 }
    function Probe() {
      counts = useNavCounts()
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(<Probe />))
    expect(counts).toEqual({ waiting: 1, running: 1, review: 2 })

    // A reply sent: the waiting run works again; a new run starts.
    await act(async () => emit('runner:run', run('a', 'running')))
    await act(async () => emit('runner:run', run('d', 'waiting')))
    expect(counts).toEqual({ waiting: 1, running: 2, review: 2 })

    // An approval on the Review page: the list is read again, once, after a short pause.
    api.review.list.mockResolvedValue([{ applicationId: 'y' }])
    await act(async () => {
      emit('applications:changed')
      emit('pipeline:changed')
    })
    expect(counts.review).toBe(2)
    await act(async () => new Promise((r) => setTimeout(r, 900)))
    expect(counts.review).toBe(1)
    expect(api.review.list).toHaveBeenCalledTimes(2)
  })

  it('keeps an event that arrives before the list', async () => {
    let resolve: (runs: RunSummary[]) => void = () => undefined
    api.runner.listRuns.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const { useNavCounts } = await import('./useNavCounts')
    let counts = { waiting: 0, running: 0, review: 0 }
    function Probe() {
      counts = useNavCounts()
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(<Probe />))
    await act(async () => emit('runner:run', run('a', 'finished')))
    await act(async () => resolve([run('a', 'waiting'), run('b', 'waiting')]))
    expect(counts).toMatchObject({ waiting: 1, running: 0 })
  })
})
