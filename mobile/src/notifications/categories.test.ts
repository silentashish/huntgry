import { NOTIFICATION_CATEGORIES } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { ANDROID_CHANNELS, CATEGORY_LABEL, GENERIC_BODY, categoryOf, routeFor, waitingRun, type RouteContext } from './categories'

const EMPTY: RouteContext = { queue: null, runInfo: {} }
const at = (min: number) => new Date(Date.UTC(2026, 9, 9, 12, min)).toISOString()

describe('notification categories', () => {
  it('reads only a known category from a payload', () => {
    expect(categoryOf({ category: 'needs-reply' })).toBe('needs-reply')
    expect(categoryOf({ category: 'failed', extra: 1 })).toBe('failed')
    for (const bad of [null, undefined, 'needs-reply', {}, { category: 'spam' }, { category: 1 }, []]) expect(categoryOf(bad)).toBeNull()
  })

  it('has one Android channel per category, with the category as its id (the relay sends channelId: category)', () => {
    expect(ANDROID_CHANNELS.map((c) => c.id).sort()).toEqual([...NOTIFICATION_CATEGORIES].sort())
    for (const c of ANDROID_CHANNELS) expect(c.name.length).toBeGreaterThan(0)
  })

  it('uses the relay\'s fixed generic bodies when the desktop sends no details', () => {
    // relay/src/push.ts PUSH_BODIES: the same words, so a toast and a banner say the same thing.
    expect(GENERIC_BODY).toEqual({
      'needs-reply': 'A run needs your reply',
      'usage-limit': 'Paused: usage limit',
      'pipeline-finished': 'Pipeline finished',
      'needs-review': 'Results need your review',
      failed: 'Something failed'
    })
    expect(Object.keys(CATEGORY_LABEL).sort()).toEqual([...NOTIFICATION_CATEGORIES].sort())
  })
})

describe('routing a tap', () => {
  it('opens Review, Home and the Queue for the categories without a run', () => {
    expect(routeFor('needs-review', EMPTY)).toEqual({ href: '/review', settled: true })
    expect(routeFor('usage-limit', EMPTY)).toEqual({ href: '/', settled: true })
    expect(routeFor('pipeline-finished', EMPTY)).toEqual({ href: '/', settled: true })
    expect(routeFor('failed', EMPTY)).toEqual({ href: '/queue', settled: true })
  })

  it('opens the Queue for "needs reply" until a waiting run is known, then the run', () => {
    expect(routeFor('needs-reply', EMPTY)).toEqual({ href: '/queue', settled: false })
    const ctx: RouteContext = { queue: { items: [{ runId: 'run-1', status: 'needs-reply', updatedAt: at(1) }] }, runInfo: {} }
    expect(routeFor('needs-reply', ctx)).toEqual({ href: '/run/run-1', settled: true })
  })

  it('picks the run that waits and changed last, from the queue or the runs seen', () => {
    const ctx: RouteContext = {
      queue: {
        items: [
          { runId: 'run-a', status: 'needs-reply', updatedAt: at(1) },
          { runId: 'run-b', status: 'running', updatedAt: at(5) },
          { runId: null, status: 'needs-reply', updatedAt: at(9) }
        ]
      },
      runInfo: { 'run-c': { id: 'run-c', status: 'waiting', updatedAt: at(3) } }
    }
    expect(waitingRun(ctx)).toBe('run-c')
  })

  it('trusts the newer of the queue and run.changed about whether a run still waits', () => {
    const answered: RouteContext = {
      queue: { items: [{ runId: 'run-a', status: 'running', updatedAt: at(4) }] },
      runInfo: { 'run-a': { id: 'run-a', status: 'waiting', updatedAt: at(2) } }
    }
    expect(waitingRun(answered)).toBeNull()
    const waitsAgain: RouteContext = { ...answered, runInfo: { 'run-a': { id: 'run-a', status: 'waiting', updatedAt: at(6) } } }
    expect(waitingRun(waitsAgain)).toBe('run-a')
  })

  it('escapes the run id in the path', () => {
    const ctx: RouteContext = { queue: null, runInfo: { 'a/b': { id: 'a/b', status: 'waiting', updatedAt: at(1) } } }
    expect(routeFor('needs-reply', ctx).href).toBe('/run/a%2Fb')
  })
})
