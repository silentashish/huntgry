import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@shared/runner-types'
import { LIMITS, jsonBytes, requireEvent, type Envelope } from '@shared/remote'
import { pageTranscript, projectJobsPage, projectQueue, projectReviewList, projectRun, projectRunPage, projectRunsPage, projectStatus, projectTranscriptItem } from './project'
import { job, queueState, run } from './test-helpers'

/**
 * ADR-0001 "DTO rules": every projection drops what never leaves the Mac, truncates to the
 * package bounds and serialises under the plaintext budget.
 */

const MARKERS = ['MARKER_JOB_DESCRIPTION', 'MARKER_URL', 'MARKER_NOTES', 'MARKER_SESSION', 'MARKER_OUTPUT_FOLDER', 'MARKER_FILE', 'MARKER_PENDING_REPLY', 'MARKER_DESCRIPTION']
const envelope = (body: unknown): Envelope => ({ v: 1, sid: 's', from: 'desktop', seq: 1, ts: new Date().toISOString(), ttl: 60, kind: 'event', id: 'x', name: 'y', body })

describe('project.ts', () => {
  it('never lets jobDescription, notes, jobUrl, sessionId, outputFolder, outputFiles or pendingReply reach the wire', () => {
    const outputs = [
      projectRun(run()),
      projectQueue(queueState()),
      projectRunsPage([run(), run({ id: '20260930-010203-ffffff' })]),
      projectRunPage(run(), [{ kind: 'user', id: 'i0', text: 'hello' }]),
      projectJobsPage([job('url:abc123')]),
      projectStatus({ desktopName: 'Mac', appVersion: '0.1.0', workspace: { id: 'w'.repeat(32), name: 'cv' }, queue: queueState(), agents: [{ id: 'claude', ready: true }] })
    ]
    for (const out of outputs) {
      const text = JSON.stringify(out)
      for (const m of MARKERS) expect(text, m).not.toContain(m)
      expect(text).not.toContain('params')
      expect(text).not.toContain('pendingReply')
    }
    const r = projectRun(run())
    expect(Object.keys(r).sort()).toEqual(['agent', 'costUsd', 'createdAt', 'files', 'id', 'job', 'live', 'options', 'status', 'title', 'updatedAt'].sort())
    expect(r.files).toEqual(['resume.pdf'])
    expect(r.job).toEqual({ company: 'Acme', role: 'Engineer', jobId: '42', source: 'url' })
    const q = projectQueue(queueState())
    expect(q.items[0].hasPendingReply).toBe(true)
    expect(Object.keys(q.items[0])).not.toContain('options')
  })

  it('the status carries the workspace name and id, never a path', () => {
    const s = projectStatus({ desktopName: 'Mac', appVersion: '0.1.0', workspace: { id: 'ab'.repeat(16), name: 'cv' }, queue: queueState(), agents: [] })
    expect(s.desktop).toEqual({ name: 'Mac', appVersion: '0.1.0', workspaceName: 'cv', workspaceId: 'ab'.repeat(16) })
    expect(JSON.stringify(s)).not.toMatch(/\/Users|path/)
    expect(s.queue).toEqual({ active: 1, needsReply: 0, failed: 0, paused: false })
    expect(s.pipeline).toBeNull()
  })

  it('truncates errors to errorBytes and transcript text / output to 8 KiB with truncated: true', () => {
    const r = projectRun(run({ error: 'e'.repeat(5000) }))
    expect(r.error).toHaveLength(LIMITS.errorBytes)
    const big = 'x'.repeat(20_000)
    const items: TranscriptItem[] = [
      { kind: 'assistant', id: 'a', text: big },
      { kind: 'tool', id: 't', name: 'Bash', summary: 's'.repeat(5000), status: 'ok', output: big },
      { kind: 'result', id: 'r', ok: true, text: big, costUsd: 1, durationMs: 2, denials: Array.from({ length: 40 }, (_, i) => `d${i}`) },
      { kind: 'notice', id: 'n', level: 'error', text: big }
    ]
    const projected = items.map(projectTranscriptItem)
    for (const p of projected) {
      if ('text' in p) expect(jsonBytes(p.text) - 2).toBeLessThanOrEqual(LIMITS.transcriptItemTextBytes)
      if (p.kind === 'tool') {
        expect(p.output!.length).toBe(LIMITS.transcriptItemTextBytes)
        expect(p.truncated).toBe(true)
        expect(p.summary.length).toBe(LIMITS.transcriptSummaryBytes)
      }
      if (p.kind === 'result') expect(p.denials).toHaveLength(LIMITS.transcriptDenials)
      if (p.kind === 'assistant' || p.kind === 'notice') expect(p.truncated).toBe(true)
    }
    // Cut without splitting a code point.
    const emoji = projectTranscriptItem({ kind: 'assistant', id: 'e', text: '😀'.repeat(5000) })
    expect(() => new TextEncoder().encode((emoji as { text: string }).text)).not.toThrow()
    expect((emoji as { text: string }).text.endsWith('😀')).toBe(true)
  })

  it('pages transcripts at 20 items or the plaintext budget, whichever comes first', () => {
    const small: TranscriptItem[] = Array.from({ length: 45 }, (_, i) => ({ kind: 'user', id: `i${i}`, text: `m${i}` }))
    const p1 = pageTranscript(small, 0)
    expect(p1.items).toHaveLength(LIMITS.transcriptPageItems)
    expect(p1.nextSeq).toBe(20)
    const p3 = pageTranscript(small, 40)
    expect(p3.items).toHaveLength(5)
    expect(p3.nextSeq).toBeUndefined()

    const huge: TranscriptItem[] = Array.from({ length: 20 }, (_, i) => ({ kind: 'assistant', id: `h${i}`, text: 'x'.repeat(8 * 1024) }))
    const page = pageTranscript(huge, 0)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(20)
    expect(page.nextSeq).toBe(page.items.length)
    const body = projectRunPage(run(), huge, 0)
    expect(jsonBytes(envelope(body))).toBeLessThanOrEqual(LIMITS.plaintextBytes)
  })

  it('caps queue states at queueItems, active first, with `more`', () => {
    const base = queueState().items[0]
    const items = Array.from({ length: 50 }, (_, i) => ({ ...base, id: `q-20260930-010203-${i.toString(16).padStart(6, '0')}`, status: i < 40 ? ('done' as const) : ('queued' as const) }))
    const q = projectQueue({ items, concurrency: 2, paused: true })
    expect(q.items).toHaveLength(LIMITS.queueItems)
    expect(q.items.slice(0, 10).every((i) => i.status === 'queued')).toBe(true)
    expect(q.more).toBe(30)
  })

  it('bounds a queue state by serialised bytes too: 20 CJK titles with JSON-escaped errors still fit one envelope', () => {
    const base = queueState().items[0]
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      id: `q-20260930-010203-${i.toString(16).padStart(6, '0')}`,
      title: '職'.repeat(400),
      status: 'failed' as const,
      error: '\u0001'.repeat(4000)
    }))
    const q = projectQueue({ items, concurrency: 2, paused: false })
    expect(q.items.length).toBeGreaterThan(0)
    expect(q.items.length + (q.more ?? 0)).toBe(20)
    expect(q.more).toBeGreaterThan(0)
    // The whole event envelope stays under the plaintext budget, so queue.changed is never dropped.
    expect(jsonBytes(envelope(q))).toBeLessThanOrEqual(LIMITS.plaintextBytes)
    expect(() => requireEvent('queue.changed', q)).not.toThrow()
  })

  it('pages jobs and runs by cursor, flagging dismissed and tailored jobs and applying the filter', () => {
    const jobs = Array.from({ length: 120 }, (_, i) =>
      job(`url:${i.toString(16).padStart(6, '0')}`, { dismissed: i % 10 === 0, tailoredAt: i % 7 === 0 ? '2026-09-30T00:00:00.000Z' : undefined, title: i % 2 ? 'Backend' : 'Frontend' })
    )
    const p1 = projectJobsPage(jobs)
    expect(p1.items).toHaveLength(LIMITS.jobsPageItems)
    expect(p1.nextCursor).toBe(p1.items[49].id)
    const p2 = projectJobsPage(jobs, p1.nextCursor)
    expect(p2.items[0].id).toBe(jobs[50].id)
    const p3 = projectJobsPage(jobs, p2.nextCursor)
    expect(p3.items).toHaveLength(20)
    expect(p3.nextCursor).toBeUndefined()
    // Every saved job exactly once across the pages, in the desktop's order.
    expect([...p1.items, ...p2.items, ...p3.items].map((j) => j.id)).toEqual(jobs.map((j) => j.id))
    expect(p1.items[0]).toEqual({ id: 'url:000000', title: 'Frontend', company: 'Co 000000', location: 'Remote', source: 'url', tailored: true, dismissed: true, savedAt: '2026-09-30T00:00:00.000Z' })
    expect(p1.items[1]).not.toHaveProperty('dismissed')
    expect(p1.items[1]).not.toHaveProperty('tailored')
    // Never the description or the posting URL.
    expect(JSON.stringify(p1)).not.toMatch(/MARKER_DESCRIPTION|jobs\.example\.com/)
    // An unknown cursor (the job was removed) restarts at the top.
    expect(projectJobsPage(jobs, 'url:gone').items[0].id).toBe('url:000000')
    const filtered = projectJobsPage(jobs, undefined, 'backend')
    expect(filtered.items.every((j) => j.title === 'Backend')).toBe(true)
    const runs = Array.from({ length: 60 }, (_, i) => run({ id: `20260930-010203-${i.toString(16).padStart(6, '0')}` }))
    const r1 = projectRunsPage(runs)
    expect(r1.items).toHaveLength(LIMITS.runsPageItems)
    expect(projectRunsPage(runs, r1.nextCursor).items).toHaveLength(10)
  })

  it('bounds review.list by count and bytes with `more`, and never sends a path from a reason (#42)', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      item: { applicationId: `${'r'.repeat(190)}/${'c'.repeat(190)}/${String(i).padStart(4, '0')}${'j'.repeat(190)}`, runId: '20261009-120000-abcdef', title: 'T'.repeat(400), state: 'needs-attention' as const, reason: `Failed: see /Users/me/cv/x/build.log ${'e'.repeat(2000)}`, at: '2026-10-09T12:00:00.000Z', build: { status: 'pass' as const, failed: [], warnings: 0, resumePages: 1 }, hasCover: false, jobUrl: 'https://MARKER_URL.example' },
      openGaps: i
    }))
    const list = projectReviewList(entries)
    expect(list.items.length).toBeLessThan(LIMITS.reviewItems)
    expect(list.more).toBe(80 - list.items.length)
    expect(jsonBytes(envelope(list))).toBeLessThanOrEqual(LIMITS.plaintextBytes)
    expect(JSON.stringify(list)).not.toMatch(/\/Users|MARKER_URL|build":/)
    expect(list.items[0].reason!.length).toBeLessThanOrEqual(LIMITS.errorBytes)
    expect(projectReviewList(entries.slice(0, 3)).more).toBeUndefined()
  })

  it('every DTO with the largest fields fits the plaintext budget and passes the package guard', () => {
    const long = 'T'.repeat(400)
    const bodies: [string, unknown][] = [
      ['run.changed', projectRun(run({ title: long, error: 'e'.repeat(5000), params: { ...run().params, company: long, role: long } }))],
      ['queue.changed', projectQueue({ items: Array.from({ length: 100 }, (_, i) => ({ ...queueState().items[0], id: `q-20260930-010203-${i.toString(16).padStart(6, '0')}`, title: long, error: 'e'.repeat(5000) })), concurrency: 4, paused: false })],
      ['status', projectStatus({ desktopName: long, appVersion: '0.1.0', workspace: { id: 'a'.repeat(128), name: long }, queue: queueState(), agents: [{ id: 'claude', ready: true }, { id: 'codex', ready: false }, { id: 'antigravity', ready: false }] })]
    ]
    for (const [name, body] of bodies) {
      expect(() => requireEvent(name, body)).not.toThrow()
      expect(jsonBytes(envelope(body)), name).toBeLessThanOrEqual(LIMITS.plaintextBytes)
    }
    const jobsPage = projectJobsPage(Array.from({ length: 50 }, (_, i) => job(`url:${i.toString(16).padStart(6, '0')}`, { title: long, company: long, location: long })))
    expect(jsonBytes(envelope(jobsPage))).toBeLessThanOrEqual(LIMITS.plaintextBytes)
    const heavy = Array.from({ length: 50 }, (_, i) => run({ id: `20260930-010203-${i.toString(16).padStart(6, '0')}`, title: long, error: 'e'.repeat(2000) }))
    const runsPage = projectRunsPage(heavy)
    expect(jsonBytes(envelope(runsPage))).toBeLessThanOrEqual(LIMITS.plaintextBytes)
    expect(runsPage.items.length).toBeLessThan(50)
    expect(runsPage.nextCursor).toBe(runsPage.items[runsPage.items.length - 1].id)
    const rest = projectRunsPage(heavy, runsPage.nextCursor)
    expect(runsPage.items.length + rest.items.length).toBeGreaterThanOrEqual(Math.min(50, runsPage.items.length * 2))
  })
})
