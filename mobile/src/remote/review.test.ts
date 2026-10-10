import type { RemoteFile, ReviewDetail } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { REVIEW_COPY, approvalGate, approvalIds, canRerun, keepTicks, requiredPreviews } from './review'

const H = (c: string) => c.repeat(64)

export const DETAIL: ReviewDetail = {
  applicationId: 'em-platform/figma/url-0123456789abcdef',
  runId: 'run-figma',
  title: 'EM, Platform · Figma',
  reviewNotes: '## Gaps\n- gRPC',
  openGaps: ['gRPC in production'],
  proposedReframings: [
    { id: H('1'), sourceFact: 'Managed a platform team of 6+', wording: 'Led a 4-person platform team' },
    { id: H('2'), sourceFact: 'Owned on-call', wording: 'Owned the on-call rotation' }
  ],
  verify: { ok: true, report: '{"status":"pass"}' },
  artifacts: [
    { file: 'resume.pdf', bytes: 60_000, sha256: H('a') },
    { file: 'cover.pdf', bytes: 40_000, sha256: H('b') },
    { file: 'resume-page-1.jpg', bytes: 30_000, sha256: H('c') },
    { file: 'cover-page-1.jpg', bytes: 20_000, sha256: H('d') },
    { file: 'resume-page-2.jpg', bytes: 30_000, sha256: H('e') }
  ],
  revision: H('9'),
  state: 'unreviewed'
}

const holding = (map: Partial<Record<RemoteFile, string>>) => (file: RemoteFile) => map[file] ?? null

describe('approval gate', () => {
  it('opens only once every page 1 of this revision has loaded with its listed hash', () => {
    expect(requiredPreviews(DETAIL)).toEqual(['resume-page-1.jpg', 'cover-page-1.jpg'])
    expect(approvalGate(DETAIL, holding({}))).toMatchObject({ ok: false, reason: 'loading', message: REVIEW_COPY.loading })
    expect(approvalGate(DETAIL, holding({ 'resume-page-1.jpg': H('c') }))).toMatchObject({ ok: false, reason: 'loading' })
    // A preview of another revision (an older hash) does not count.
    expect(approvalGate(DETAIL, holding({ 'resume-page-1.jpg': H('c'), 'cover-page-1.jpg': H('0') }))).toMatchObject({ ok: false })
    expect(approvalGate(DETAIL, holding({ 'resume-page-1.jpg': H('c'), 'cover-page-1.jpg': H('d') }))).toEqual({ ok: true })
  })

  it('waits for the PDFs when no preview is listed, and refuses when there is nothing to check', () => {
    const noPages = { ...DETAIL, artifacts: DETAIL.artifacts.filter((a) => a.file.endsWith('.pdf')) }
    expect(requiredPreviews(noPages)).toEqual(['resume.pdf', 'cover.pdf'])
    expect(approvalGate(noPages, holding({ 'resume.pdf': H('a'), 'cover.pdf': H('b') }))).toEqual({ ok: true })
    expect(approvalGate({ ...DETAIL, artifacts: [] }, holding({}))).toMatchObject({ ok: false, reason: 'no-previews' })
  })

  it('a truncated detail is approved on the Mac', () => {
    const all = holding({ 'resume-page-1.jpg': H('c'), 'cover-page-1.jpg': H('d') })
    expect(approvalGate({ ...DETAIL, truncated: true }, all)).toMatchObject({ ok: false, reason: 'truncated', message: expect.stringMatching(/on the Mac/) })
  })

  it('an approved or discarded result offers nothing', () => {
    const all = holding({ 'resume-page-1.jpg': H('c'), 'cover-page-1.jpg': H('d') })
    expect(approvalGate({ ...DETAIL, state: 'approved' }, all)).toMatchObject({ ok: false, reason: 'decided' })
    expect(approvalGate({ ...DETAIL, state: 'discarded' }, all)).toMatchObject({ ok: false, reason: 'decided' })
    expect(canRerun({ ...DETAIL, state: 'approved' })).toBe(false)
    expect(canRerun({ ...DETAIL, runId: 'none' })).toBe(false)
    expect(canRerun(DETAIL)).toBe(true)
  })
})

describe('approved ids', () => {
  it('are only ids this detail listed, in its order, without repeats', () => {
    expect(approvalIds(DETAIL, [H('2'), 'forged', H('1'), H('2')])).toEqual([H('1'), H('2')])
    expect(approvalIds(DETAIL, [])).toEqual([])
  })

  it('ticks survive a new revision only for reframings still listed', () => {
    const next = { ...DETAIL, revision: H('8'), proposedReframings: [DETAIL.proposedReframings[1]] }
    expect([...keepTicks(next, [H('1'), H('2')])]).toEqual([H('2')])
  })
})
