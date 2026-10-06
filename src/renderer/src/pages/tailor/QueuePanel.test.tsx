import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it, vi } from 'vitest'
import type { QueueItem } from '@shared/queue-types'
import { QueueRow } from './QueuePanel'

// The preload bridge (`window.api`) does not exist here; a row only calls it on a click.
vi.mock('../../api', () => ({ api: {}, errorText: String }))

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: 'q-20260930-010203-a1b2c3',
  jobId: 'url:a',
  title: 'Forward Deployed AI Engineer · Bertram Capital',
  options: { coverLetter: false, dateStyle: 'right' },
  agent: 'claude',
  status: 'done',
  runId: '20260930-120000-abcdef',
  attempts: 1,
  createdAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  unattended: true,
  pipelineId: 'p',
  applicationId: 'Engineer/Bertram Capital/a',
  ...over
})

const render = (i: QueueItem) =>
  renderToStaticMarkup(
    <MantineProvider>
      <QueueRow item={i} onAct={() => undefined} onOpenRun={() => undefined} onReview={() => undefined} />
    </MantineProvider>
  )

describe('QueueRow', () => {
  it('offers Review only while the result waits for it, and shows the decision once made (#72)', () => {
    for (const outcome of ['unreviewed', 'needs-attention'] as const) {
      const html = render(item({ outcome }))
      expect(html).toContain(outcome === 'unreviewed' ? 'Unreviewed' : 'Needs attention')
      expect(html).toMatch(/>Review</)
    }
    const approved = render(item({ outcome: 'approved' }))
    expect(approved).toContain('Approved')
    expect(approved).not.toContain('Unreviewed')
    expect(approved).not.toMatch(/>Review</)
    expect(approved).toContain('Open run')
    const discarded = render(item({ outcome: 'discarded' }))
    expect(discarded).toContain('Discarded')
    expect(discarded).not.toMatch(/>Review</)
  })
})
