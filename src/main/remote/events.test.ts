import { describe, expect, it } from 'vitest'
import type { PipelineCounts, PipelineState as DesktopPipelineState, PipelineSummary as DesktopPipelineSummary } from '@shared/pipeline-types'
import { requireEvent, type NotificationCategory, type RemoteEventName, type StatusSummary } from '@shared/remote'
import { RemoteEvents } from './events'
import { projectPipeline, projectPipelineStatus, projectPipelineSummary, projectStatus, safeText } from './project'
import { queueState, run } from './test-helpers'

const ISO = '2026-10-09T12:00:00.000Z'
const NOW = Date.parse(ISO)

const counts = (over: Partial<PipelineCounts> = {}): PipelineCounts => ({
  queued: 2,
  running: 1,
  needsReply: 0,
  unreviewed: 1,
  needsAttention: 1,
  approved: 1,
  discarded: 0,
  failed: 0,
  cancelled: 0,
  skipped: 1,
  total: 7,
  ...over
})

function state(over: Partial<DesktopPipelineState> = {}): DesktopPipelineState {
  return {
    id: 'p-1',
    status: 'running',
    counts: counts(),
    startedAt: ISO,
    etaMinutes: 30,
    costUsd: 0.5,
    startedJobs: 3,
    onBattery: false,
    keepAwake: true,
    warnings: [],
    interrupted: false,
    agent: 'claude',
    concurrency: 2,
    ...over
  }
}

function harness() {
  const sent: { name: RemoteEventName; body: unknown; pushText?: string; hint: NotificationCategory | null | undefined }[] = []
  let statuses = 0
  const status: StatusSummary = projectStatus({ desktopName: 'Mac', appVersion: '1', workspace: { id: 'w'.repeat(32), name: 'cv' }, queue: queueState(), agents: [] })
  const events = new RemoteEvents({
    broadcast: async (name, body, pushText, hint) => {
      // Everything forwarded passes the package's event guard.
      requireEvent(name, body)
      sent.push({ name, body, pushText, hint })
    },
    status: async () => {
      statuses++
      return status
    },
    now: () => NOW
  })
  return { events, sent, statuses: () => statuses }
}

describe('pipeline projections (#41)', () => {
  it('maps #31 statuses and counts onto the phone DTO (built / needs review / failed / skipped)', () => {
    const p = projectPipeline(state(), NOW)
    expect(p).toEqual({
      status: 'running',
      agent: 'claude',
      counts: { total: 7, done: 3, running: 1, queued: 2, failed: 0, unreviewed: 1, needsAttention: 1, needsReply: 0, cancelled: 0, skipped: 1 },
      eta: new Date(NOW + 30 * 60_000).toISOString(),
      startedAt: ISO,
      updatedAt: ISO
    })
    expect(projectPipeline(state({ status: 'stopped-budget', stopReason: 'Budget reached: 2 of 2 jobs started.' })).status).toBe('paused')
    expect(projectPipeline(state({ status: 'stopping' })).status).toBe('running')
    expect(projectPipeline(state({ status: 'finished', etaMinutes: null })).eta).toBeUndefined()
    const waiting = projectPipeline(state({ status: 'waiting-limit', until: ISO, limitMessage: "You've hit your limit" }))
    expect(waiting).toMatchObject({ status: 'waiting-limit', waitingLimitUntil: ISO, reason: "You've hit your limit" })
    expect(projectPipelineStatus(state({ status: 'waiting-limit', until: ISO }))).toEqual({ status: 'waiting-limit', until: ISO })
    expect(projectPipelineStatus(null)).toBeNull()
  })

  it('never sends a path from a desktop reason, and cuts it to errorBytes', () => {
    const p = projectPipeline(state({ status: 'paused', stopReason: 'Cannot start Claude: spawn /Users/me/.local/bin/claude ENOENT in ~/cv/x' }))
    expect(p.reason).toBe('Cannot start Claude: spawn … ENOENT in …')
    expect(safeText('x'.repeat(5000))).toHaveLength(1024)
  })

  it('summaries: finished, stopped by the user, stopped on the budget', () => {
    const base: DesktopPipelineSummary = { id: 'p-1', startedAt: ISO, finishedAt: ISO, counts: counts({ queued: 0, running: 0 }), costUsd: 1.25, items: [], skipped: [] }
    expect(projectPipelineSummary(base)).toMatchObject({ status: 'finished', costUsd: 1.25, counts: { done: 3, skipped: 1 } })
    expect(projectPipelineSummary({ ...base, stopReason: 'Stopped by you.' }).status).toBe('stopped')
    expect(projectPipelineSummary({ ...base, stopReason: 'Budget reached: $5.00 of $5.00 spent.' }).status).toBe('budget')
  })

  it('the status carries the pipeline and the unreviewed count', () => {
    const s = projectStatus({ desktopName: 'Mac', appVersion: '1', workspace: { id: 'w'.repeat(32), name: 'cv' }, queue: queueState(), agents: [], pipeline: state({ status: 'paused' }), unreviewed: 4 })
    expect(s.pipeline).toEqual({ status: 'paused' })
    expect(s.review).toEqual({ unreviewed: 4 })
  })
})

describe('RemoteEvents push hints (#41)', () => {
  it('the first state after start-up is a baseline: a limit already waited on is not pushed again', async () => {
    const h = harness()
    await h.events.handle('pipeline:changed', state({ status: 'waiting-limit', until: ISO }))
    expect(h.sent.map((e) => [e.name, e.hint])).toEqual([
      ['pipeline.changed', null],
      ['status', undefined]
    ])
    await h.events.handle('pipeline:changed', state({ status: 'waiting-limit', until: ISO, etaMinutes: 29 }))
    expect(h.sent.filter((e) => e.hint)).toEqual([])
  })

  it('usage-limit once per reset time; failed on an error pause and on a job failed for good; needs-reply on a question', async () => {
    const h = harness()
    await h.events.handle('pipeline:changed', null)
    await h.events.handle('pipeline:changed', state())
    await h.events.handle('pipeline:changed', state({ status: 'waiting-limit', until: ISO, limitMessage: 'session limit' }))
    await h.events.handle('pipeline:changed', state({ status: 'waiting-limit', until: ISO, etaMinutes: 10 }))
    const later = new Date(NOW + 3_600_000).toISOString()
    await h.events.handle('pipeline:changed', state({ status: 'waiting-limit', until: later }))
    await h.events.handle('pipeline:changed', state({ status: 'paused', stopReason: 'Claude reached its spend limit: /Users/me/x/y' }))
    await h.events.handle('pipeline:changed', state({ status: 'paused', stopReason: 'Claude reached its spend limit: /Users/me/x/y', etaMinutes: 3 }))
    await h.events.handle('pipeline:changed', state({ counts: counts({ failed: 1 }) }))
    await h.events.handle('pipeline:changed', state({ counts: counts({ failed: 1, needsReply: 1 }) }))
    // A user pause carries no push.
    await h.events.handle('pipeline:changed', state({ status: 'paused', counts: counts({ failed: 1, needsReply: 1 }) }))
    const hinted = h.sent.filter((e) => e.hint).map((e) => [e.hint, e.pushText])
    expect(hinted).toEqual([
      ['usage-limit', 'session limit'],
      ['usage-limit', undefined],
      ['failed', 'Claude reached its spend limit: …'],
      ['failed', undefined],
      ['needs-reply', undefined]
    ])
  })

  it('a new pipeline is compared with nothing, not with the last one', async () => {
    const h = harness()
    await h.events.handle('pipeline:changed', null)
    await h.events.handle('pipeline:changed', state({ id: 'p-1', counts: counts({ failed: 3 }) }))
    await h.events.handle('pipeline:changed', state({ id: 'p-2', counts: counts({ failed: 1 }) }))
    expect(h.sent.filter((e) => e.hint).map((e) => e.hint)).toEqual(['failed', 'failed'])
  })

  it('refreshes the status only when the pipeline status, its limit or the pipeline itself changed', async () => {
    const h = harness()
    await h.events.handle('pipeline:changed', state())
    await h.events.handle('pipeline:changed', state({ etaMinutes: 20 }))
    await h.events.handle('pipeline:changed', state({ status: 'paused' }))
    await h.events.handle('pipeline:changed', null)
    await h.events.handle('pipeline:changed', null)
    expect(h.statuses()).toBe(3)
  })

  it('pipeline.finished carries the summary and its push text; the hint is the category default', async () => {
    const h = harness()
    await h.events.handle('pipeline:finished', { id: 'p-1', startedAt: ISO, finishedAt: ISO, counts: counts({ queued: 0, running: 0, failed: 2 }), costUsd: 0, items: [], skipped: [] })
    expect(h.sent[0]).toMatchObject({ name: 'pipeline.finished', hint: undefined, pushText: '1 ready for review · 3 need a look' })
  })

  it('an attended run asking a question pushes needs-reply; an unattended run never pushes on its own', async () => {
    const h = harness()
    await h.events.handle('runner:run', run({ status: 'waiting' }))
    await h.events.handle('runner:run', run({ status: 'failed', error: 'usage limit reached' }))
    await h.events.handle('runner:run', run({ status: 'waiting', unattended: true }))
    await h.events.handle('runner:run', run({ status: 'failed', error: 'boom', params: { ...run().params, unattended: true } }))
    expect(h.sent.map((e) => e.hint)).toEqual(['needs-reply', 'usage-limit', null, null])
    expect(JSON.stringify(h.sent)).not.toContain('MARKER_')
  })
})
