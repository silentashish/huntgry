import { describe, expect, it } from 'vitest'
import { errorOf } from './check'
import {
  requireEventBody,
  requireJobsPage,
  requirePipelineState,
  requirePipelineSummary,
  requireQueueItem,
  requireQueueState,
  requireRemoteRun,
  requireReviewDetail,
  requireReviewItem,
  requireRunPage,
  requireRunsPage,
  requireStatusSummary,
  requireTranscriptItem,
  requireTranscriptPage
} from './dto'
import { LIMITS } from './limits'
import type { PipelineState, RemoteQueueItem, RemoteRun, RemoteTranscriptItem, ReviewDetail, StatusSummary } from './protocol'

/**
 * Every DTO the phone renders is validated field by field, and the first value over each
 * limit is refused (review finding on #56: a shape-only check left the DTO rules unenforced).
 */

const ISO = '2026-09-30T12:00:00.000Z'
const SHA = 'a'.repeat(64)
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return errorOf(e).code
  }
  return 'ok'
}
const over = (n: number, ch = 'x') => ch.repeat(n + 1)

const status: StatusSummary = {
  desktop: { name: 'Mac', appVersion: '0.1.0', workspaceName: 'acme', workspaceId: 'ws-1' },
  queue: { active: 1, needsReply: 0, failed: 0, paused: false },
  pipeline: { status: 'waiting-limit', until: ISO },
  review: { unreviewed: 2 },
  agents: [{ id: 'claude', ready: true }]
}
const run: RemoteRun = {
  id: 'r1',
  title: 'Backend · Acme',
  agent: 'claude',
  status: 'running',
  job: { company: 'Acme', role: 'Backend', jobId: 'url:0123456789abcdef', source: 'url' },
  options: { coverLetter: true, dateStyle: 'inline' },
  createdAt: ISO,
  updatedAt: ISO,
  files: ['resume.pdf'],
  costUsd: 0.5,
  live: true
}
const item: RemoteQueueItem = { id: 'q1', jobId: 'url:0123456789abcdef', title: 'Backend · Acme', agent: 'codex', status: 'queued', runId: null, attempts: 0, hasPendingReply: false, createdAt: ISO, updatedAt: ISO }
const text: RemoteTranscriptItem = { kind: 'assistant', id: 't1', text: 'hello' }
const tool: RemoteTranscriptItem = { kind: 'tool', id: 't2', name: 'Bash', summary: 'ls', status: 'ok', output: 'a b' }
const result: RemoteTranscriptItem = { kind: 'result', id: 't3', ok: true, text: 'done', costUsd: 1, durationMs: 10, denials: [] }
const pipeline: PipelineState = { status: 'running', agent: 'claude', counts: { total: 3, done: 1, running: 1, queued: 1, failed: 0, unreviewed: 1 }, startedAt: ISO, updatedAt: ISO }
const review: ReviewDetail = {
  applicationId: 'backend/acme/123',
  runId: 'r1',
  title: 'Backend · Acme',
  reviewNotes: '# notes',
  openGaps: ['Kubernetes'],
  proposedReframings: [{ id: SHA, sourceFact: 'ran a cluster', wording: 'operated Kubernetes' }],
  verify: { ok: true, report: 'ok' },
  artifacts: [{ file: 'resume.pdf', bytes: 1000, sha256: SHA }],
  revision: SHA
}

describe('accepts every DTO and returns only its known fields', () => {
  it('status, run, queue, transcript, pipeline, review, pages', () => {
    expect(requireStatusSummary(status)).toEqual(status)
    expect(requireStatusSummary({ ...status, pipeline: null })).toEqual({ ...status, pipeline: null })
    expect(requireRemoteRun(run)).toEqual(run)
    expect(requireRemoteRun({ ...run, usage: { inputTokens: 1, outputTokens: 2 }, error: 'x' })).toMatchObject({ usage: { inputTokens: 1, outputTokens: 2 }, error: 'x' })
    expect(requireQueueItem(item)).toEqual(item)
    expect(requireQueueState({ items: [item], concurrency: 2, paused: true, more: 3 })).toEqual({ items: [item], concurrency: 2, paused: true, more: 3 })
    for (const t of [text, tool, result]) expect(requireTranscriptItem(t)).toEqual(t)
    expect(requireTranscriptItem({ ...text, kind: 'notice', level: 'error', truncated: true })).toEqual({ ...text, kind: 'notice', level: 'error', truncated: true })
    expect(requireTranscriptPage({ runId: 'r1', items: [text], seq: 4 })).toEqual({ runId: 'r1', items: [text], seq: 4 })
    expect(requireRunPage({ run, items: [tool], nextSeq: 9 })).toEqual({ run, items: [tool], nextSeq: 9 })
    expect(requirePipelineState(pipeline)).toEqual(pipeline)
    // #41: the optional counts and the reason.
    const split = { ...pipeline, counts: { ...pipeline.counts, needsAttention: 1, needsReply: 0, cancelled: 2, skipped: 3 }, reason: 'Stopped by you.' }
    expect(requirePipelineState(split)).toEqual(split)
    expect(requirePipelineSummary({ status: 'budget', counts: pipeline.counts, costUsd: 3, startedAt: ISO, finishedAt: ISO })).toMatchObject({ status: 'budget' })
    expect(requireReviewItem({ applicationId: 'a', runId: 'r', title: 't', openGaps: 1, finishedAt: ISO })).toMatchObject({ openGaps: 1 })
    expect(requireReviewDetail(review)).toEqual(review)
    expect(requireReviewDetail({ ...review, reviewNotes: null }).reviewNotes).toBeNull()
    expect(requireJobsPage({ items: [{ id: 'url:1', title: 'x', savedAt: ISO, tailored: true }], nextCursor: 'c' })).toMatchObject({ nextCursor: 'c' })
    // #40: the dismissed flag.
    expect(requireJobsPage({ items: [{ id: 'url:1', title: 'x', savedAt: ISO, dismissed: true }] }).items[0].dismissed).toBe(true)
    expect(requireRunsPage({ items: [run] })).toEqual({ items: [run] })
    expect(requireEventBody('status', status)).toEqual({ name: 'status', body: status })
    expect(requireEventBody('review.needed', { count: 1, latest: { applicationId: 'a', runId: 'r', title: 't', openGaps: 0, finishedAt: ISO } })).toMatchObject({ name: 'review.needed' })
  })
})

describe('refuses the first value over each limit, wrong enums and unknown fields', () => {
  const cases: [string, () => unknown][] = [
    ['status: unknown field', () => requireStatusSummary({ ...status, workspacePath: '/Users/x' })],
    ['status: desktop name over titleChars', () => requireStatusSummary({ ...status, desktop: { ...status.desktop, name: over(LIMITS.titleChars) } })],
    ['status: unknown agent', () => requireStatusSummary({ ...status, agents: [{ id: 'gpt', ready: true }] })],
    ['status: pipeline status', () => requireStatusSummary({ ...status, pipeline: { status: 'crashed' } })],
    ['status: missing queue', () => requireStatusSummary({ desktop: status.desktop })],
    ['run: unknown field (params)', () => requireRemoteRun({ ...run, params: { jobDescription: 'secret' } })],
    ['run: job with jobDescription', () => requireRemoteRun({ ...run, job: { ...run.job, jobDescription: 'secret' } })],
    ['run: error over errorBytes', () => requireRemoteRun({ ...run, error: over(LIMITS.errorBytes) })],
    ['run: title over titleChars', () => requireRemoteRun({ ...run, title: over(LIMITS.titleChars) })],
    ['run: jobId over jobIdChars', () => requireRemoteRun({ ...run, job: { jobId: over(LIMITS.jobIdChars) } })],
    ['run: unknown file', () => requireRemoteRun({ ...run, files: ['master-profile.md'] })],
    ['run: bad status', () => requireRemoteRun({ ...run, status: 'exploded' })],
    ['run: bad date', () => requireRemoteRun({ ...run, createdAt: 'yesterday' })],
    ['queue item: pendingReply', () => requireQueueItem({ ...item, pendingReply: 'held text' })],
    ['queue item: error over errorBytes', () => requireQueueItem({ ...item, error: over(LIMITS.errorBytes) })],
    ['queue item: bad status', () => requireQueueItem({ ...item, status: 'lost' })],
    ['queue: more than queueItems', () => requireQueueState({ items: Array.from({ length: LIMITS.queueItems + 1 }, () => item), concurrency: 1, paused: false })],
    ['queue: concurrency 5', () => requireQueueState({ items: [], concurrency: 5, paused: false })],
    ['transcript: text over 8 KiB', () => requireTranscriptItem({ ...text, text: over(LIMITS.transcriptItemTextBytes) })],
    ['transcript: tool output over 8 KiB', () => requireTranscriptItem({ ...tool, output: over(LIMITS.transcriptItemTextBytes) })],
    ['transcript: result text over 8 KiB', () => requireTranscriptItem({ ...result, text: over(LIMITS.transcriptItemTextBytes) })],
    ['transcript: bad kind', () => requireTranscriptItem({ kind: 'system', id: 'x', text: '' })],
    ['transcript: tool status', () => requireTranscriptItem({ ...tool, status: 'pending' })],
    ['transcript: summary over transcriptSummaryBytes', () => requireTranscriptItem({ ...tool, summary: over(LIMITS.transcriptSummaryBytes) })],
    ['transcript: too many denials', () => requireTranscriptItem({ ...result, denials: Array.from({ length: LIMITS.transcriptDenials + 1 }, () => 'd') })],
    ['transcript page: more than transcriptPageItems', () => requireTranscriptPage({ runId: 'r', items: Array.from({ length: LIMITS.transcriptPageItems + 1 }, () => text), seq: 1 })],
    ['run page: more than transcriptPageItems', () => requireRunPage({ run, items: Array.from({ length: LIMITS.transcriptPageItems + 1 }, () => text) })],
    ['pipeline: negative count', () => requirePipelineState({ ...pipeline, counts: { ...pipeline.counts, failed: -1 } })],
    ['pipeline: missing count', () => requirePipelineState({ ...pipeline, counts: { total: 1 } })],
    ['pipeline: unknown count', () => requirePipelineState({ ...pipeline, counts: { ...pipeline.counts, approvedByPhone: 1 } })],
    ['pipeline: negative skipped', () => requirePipelineState({ ...pipeline, counts: { ...pipeline.counts, skipped: -1 } })],
    ['pipeline: reason over errorBytes', () => requirePipelineState({ ...pipeline, reason: over(LIMITS.errorBytes) })],
    ['pipeline summary: status', () => requirePipelineSummary({ status: 'running', counts: pipeline.counts, costUsd: 0, startedAt: ISO, finishedAt: ISO })],
    ['review: notes over reviewNotesInlineBytes', () => requireReviewDetail({ ...review, reviewNotes: over(LIMITS.reviewNotesInlineBytes) })],
    ['review: too many gaps', () => requireReviewDetail({ ...review, openGaps: Array.from({ length: LIMITS.reviewListItems + 1 }, () => 'g') })],
    ['review: gap over reviewEntryBytes', () => requireReviewDetail({ ...review, openGaps: [over(LIMITS.reviewEntryBytes)] })],
    ['review: reframing id not sha256', () => requireReviewDetail({ ...review, proposedReframings: [{ id: 'x', sourceFact: 'a', wording: 'b' }] })],
    ['review: report over verifyReportBytes', () => requireReviewDetail({ ...review, verify: { ok: true, report: over(LIMITS.verifyReportBytes) } })],
    ['review: too many artifacts', () => requireReviewDetail({ ...review, artifacts: Array.from({ length: LIMITS.reviewArtifacts + 1 }, () => review.artifacts[0]) })],
    ['review: artifact outside the folder', () => requireReviewDetail({ ...review, artifacts: [{ file: '../master-profile.md', bytes: 1, sha256: SHA }] })],
    ['review: revision not sha256', () => requireReviewDetail({ ...review, revision: 'v1' })],
    ['jobs page: more than jobsPageItems', () => requireJobsPage({ items: Array.from({ length: LIMITS.jobsPageItems + 1 }, () => ({ id: 'url:1', title: 'x', savedAt: ISO })) })],
    ['job: dismissed not a boolean', () => requireJobsPage({ items: [{ id: 'url:1', title: 'x', savedAt: ISO, dismissed: 'yes' }] })],
    ['job: description', () => requireJobsPage({ items: [{ id: 'url:1', title: 'x', savedAt: ISO, description: 'full posting' }] })],
    ['runs page: more than runsPageItems', () => requireRunsPage({ items: Array.from({ length: LIMITS.runsPageItems + 1 }, () => run) })],
    ['page: cursor over cursorChars', () => requireRunsPage({ items: [], nextCursor: over(LIMITS.cursorChars) })],
    ['review.needed: latest not a ReviewItem', () => requireEventBody('review.needed', { count: 1, latest: { title: 'x' } })],
    ['applications.changed: too many ids', () => requireEventBody('applications.changed', { ids: Array.from({ length: LIMITS.applicationsChangedIds + 1 }, () => 'a') })]
  ]
  for (const [label, fn] of cases) it(label, () => expect(codeOf(fn)).toBe('invalid'))

  it('the value one below each text limit passes', () => {
    expect(codeOf(() => requireRemoteRun({ ...run, error: 'e'.repeat(LIMITS.errorBytes) }))).toBe('ok')
    expect(codeOf(() => requireTranscriptItem({ ...text, text: 't'.repeat(LIMITS.transcriptItemTextBytes) }))).toBe('ok')
    expect(codeOf(() => requireReviewDetail({ ...review, reviewNotes: 'n'.repeat(LIMITS.reviewNotesInlineBytes) }))).toBe('ok')
    expect(codeOf(() => requireTranscriptPage({ runId: 'r', items: Array.from({ length: LIMITS.transcriptPageItems }, () => text), seq: 1 }))).toBe('ok')
  })
})
