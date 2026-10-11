import { describe, expect, it } from 'vitest'
import type { ProposedReframing, ReviewItem } from '@shared/review-types'
import { approveHint, buildWarnings, filterItems, reframingLabel, reviewEyebrow, shortRevision, shownTicked, sinceLabel } from './review-ui'

const item = (applicationId: string, state: ReviewItem['state']): ReviewItem => ({
  applicationId,
  runId: 'r',
  title: applicationId,
  state,
  at: '2026-10-05T06:00:00.000Z',
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  hasCover: false,
  jobUrl: null
})

const ITEMS = [item('a', 'unreviewed'), item('b', 'needs-attention'), item('c', 'unreviewed')]

const reframing = (id: string): ProposedReframing => ({ id, sourceFact: `fact ${id}`, wording: `wording ${id}` })
const PROPOSED = [reframing('x'), reframing('y'), reframing('z')]

describe('filterItems', () => {
  it('keeps all, the unreviewed or the ones that need attention', () => {
    expect(filterItems(ITEMS, 'all').map((i) => i.applicationId)).toEqual(['a', 'b', 'c'])
    expect(filterItems(ITEMS, 'unreviewed').map((i) => i.applicationId)).toEqual(['a', 'c'])
    expect(filterItems(ITEMS, 'attention').map((i) => i.applicationId)).toEqual(['b'])
  })
})

describe('reviewEyebrow', () => {
  it('counts each state and says when nothing waits', () => {
    expect(reviewEyebrow(ITEMS)).toBe('2 unreviewed · 1 needs attention')
    expect(reviewEyebrow([item('a', 'unreviewed')])).toBe('1 unreviewed')
    expect(reviewEyebrow([])).toBe('Nothing waiting')
  })
})

describe('sinceLabel', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')
  it('reads minutes, hours and days', () => {
    expect(sinceLabel('2026-10-05T11:59:40.000Z', now)).toBe('just now')
    expect(sinceLabel('2026-10-05T11:35:00.000Z', now)).toBe('25 min ago')
    expect(sinceLabel('2026-10-05T10:30:00.000Z', now)).toBe('1 h ago')
    expect(sinceLabel('2026-10-03T12:00:00.000Z', now)).toBe('2 d ago')
    expect(sinceLabel('not a date', now)).toBe('')
  })
})

describe('reframings on screen', () => {
  it('sends only ticked ids of the reframings shown, in their order', () => {
    expect(shownTicked(PROPOSED, new Set(['z', 'gone', 'x']))).toEqual(['x', 'z'])
    expect(shownTicked([], new Set(['x']))).toEqual([])
  })

  it('labels reframings R1… and says what Approve saves', () => {
    expect(reframingLabel(PROPOSED, 'y')).toBe('R2')
    expect(approveHint(PROPOSED, [])).toBe('Unlocks Apply for this application. Nothing is saved as a standing approval.')
    expect(approveHint(PROPOSED, ['x'])).toBe('Unlocks Apply for this application and saves R1 as a standing approval.')
    expect(approveHint(PROPOSED, ['x', 'y', 'z'])).toBe('Unlocks Apply for this application and saves R1, R2 and R3 as standing approvals.')
  })

  it('shortens the revision', () => {
    expect(shortRevision('9f3c1a2b4d5e6f')).toBe('9f3c1a2')
  })
})

describe('buildWarnings', () => {
  it('lists the soft checks that failed and the style warnings', () => {
    const report = JSON.stringify({
      ok: true,
      verify: {
        results: [
          { check: 'text_extractable', passed: true, hard: true },
          { check: 'dates_stay_with_employer', passed: false, hard: false },
          { check: 'fits_target_pages', passed: false, hard: true }
        ]
      },
      style_warnings: ['1 bullet exceeds 2 lines', 3]
    })
    expect(buildWarnings(report)).toEqual(['dates stay with employer', '1 bullet exceeds 2 lines'])
  })

  it('is empty for a report it cannot read', () => {
    expect(buildWarnings('')).toEqual([])
    expect(buildWarnings('{"ok": true}')).toEqual([])
  })
})
