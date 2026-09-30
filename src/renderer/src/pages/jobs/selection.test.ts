import { describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { QueueItem } from '@shared/queue-types'
import { activeQueueItems, selectable, selectAll, selectAllState, selectedJobs, selectionSummary, toggle } from './selection'

const job = (id: string, extra: Partial<Job> = {}): Job =>
  ({ id, source: id.split(':')[0], descriptionComplete: true, ...extra }) as Job

describe('job selection', () => {
  const shown = [job('url:a'), job('url:b'), job('url:c', { dismissed: true })]

  it('toggles one job', () => {
    const one = toggle(new Set(), 'url:a')
    expect([...one]).toEqual(['url:a'])
    expect([...toggle(one, 'url:a')]).toEqual([])
  })

  it('selects all shown jobs except dismissed ones', () => {
    expect(selectable(shown[2])).toBe(false)
    expect([...selectAll(new Set(), shown)].sort()).toEqual(['url:a', 'url:b'])
    expect(selectAllState(new Set(), shown)).toBe('none')
    expect(selectAllState(new Set(['url:a']), shown)).toBe('some')
    expect(selectAllState(new Set(['url:a', 'url:b']), shown)).toBe('all')
  })

  it('only counts selected jobs that are still shown and selectable', () => {
    const sel = new Set(['url:a', 'url:c', 'url:gone'])
    expect(selectedJobs(sel, shown).map((j) => j.id)).toEqual(['url:a'])
  })

  it('summarizes what the confirmation has to say', () => {
    const jobs = [
      job('hiring.cafe:a', { descriptionComplete: false }),
      job('indeed:b', { descriptionComplete: false }),
      job('url:c', { tailoredAt: '2026-09-30' })
    ]
    expect(selectionSummary(jobs)).toEqual({ total: 3, summaryOnly: 2, unreadable: 1, alreadyTailored: 1 })
  })

  it('maps jobs to their unfinished queue item', () => {
    const items = [
      { jobId: 'url:a', status: 'done' },
      { jobId: 'url:b', status: 'needs-reply' },
      { jobId: 'url:c', status: 'queued' }
    ] as QueueItem[]
    expect([...activeQueueItems(items).keys()]).toEqual(['url:b', 'url:c'])
  })
})
