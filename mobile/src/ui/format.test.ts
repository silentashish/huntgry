import type { RemoteQueueItem, RemoteRun } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { ago, canCancel, canRetry, dayLine, duration, money, queueCounts, queueMeta, relayHost, startsIn, tokens } from './format'

const NOW = new Date(2025, 9, 7, 12, 0, 0).getTime() // Tuesday 7 Oct, local time

const item = (over: Partial<RemoteQueueItem> = {}): RemoteQueueItem => ({
  id: 'i',
  jobId: 'url:1',
  title: 'Stripe · Senior Backend Engineer',
  agent: 'claude',
  status: 'queued',
  runId: null,
  attempts: 1,
  hasPendingReply: false,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  ...over
})

describe('formatters', () => {
  it('read like the Figma copy', () => {
    expect(dayLine(new Date(NOW))).toBe('Tuesday · 7 Oct')
    expect(duration(252_000)).toBe('4m 12s')
    expect(duration(3_900_000)).toBe('1h 05m')
    expect(tokens(61_000)).toBe('61k tok')
    expect(tokens(1_250_000)).toBe('1.3M tok')
    expect(money(0.44)).toBe('$0.44')
    expect(ago(new Date(NOW - 23 * 60_000).toISOString(), NOW)).toBe('23 min ago')
    expect(ago(new Date(NOW - 5_000).toISOString(), NOW)).toBe('now')
    expect(startsIn(new Date(NOW + 300_000).toISOString(), NOW)).toBe('starts in 5 min')
    expect(startsIn(new Date(NOW - 1).toISOString(), NOW)).toBeNull()
    expect(relayHost('https://huntgry-relay.ashish.workers.dev/x')).toBe('huntgry-relay.ashish.workers.dev')
  })

  it('build the queue card meta line from the run', () => {
    const run = { createdAt: new Date(NOW - 252_000).toISOString(), updatedAt: new Date(NOW).toISOString(), live: true, costUsd: 0.44, usage: { inputTokens: 50_000, outputTokens: 11_000 } } as RemoteRun
    expect(queueMeta(item({ status: 'needs-reply', runId: 'r' }), run, NOW)).toBe('4m 12s · 61k tok · $0.44')
    expect(queueMeta(item({ notBefore: new Date(NOW + 300_000).toISOString(), attempts: 2 }), undefined, NOW)).toBe('starts in 5 min · attempt 2')
  })
})

describe('queue rules (the desktop’s)', () => {
  it('cancel active items, retry failed or cancelled ones unless the job is queued again', () => {
    expect(canCancel(item({ status: 'needs-reply' }))).toBe(true)
    expect(canCancel(item({ status: 'done' }))).toBe(false)
    const failed = item({ id: 'a', status: 'failed' })
    expect(canRetry(failed, [failed])).toBe(true)
    expect(canRetry(failed, [failed, item({ id: 'b', status: 'queued' })])).toBe(false)
    expect(canRetry(item({ status: 'queued' }), [])).toBe(false)
  })

  it('count queued (with the page overflow), working and done today', () => {
    const items = [item({ status: 'queued' }), item({ status: 'running' }), item({ status: 'needs-reply' }), item({ status: 'done' }), item({ status: 'done', updatedAt: new Date(NOW - 2 * 86_400_000).toISOString() })]
    expect(queueCounts(items, 10, NOW)).toEqual({ queued: 11, working: 2, doneToday: 1 })
  })
})
