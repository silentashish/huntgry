import type { Job } from '@shared/jobs-types'
import type { PipelineCounts as DesktopCounts, PipelineState as DesktopPipelineState, PipelineSummary as DesktopPipelineSummary } from '@shared/pipeline-types'
import type { ReviewDetail as DesktopReviewDetail, ReviewItem as DesktopReviewItem } from '@shared/review-types'
import type { QueueItem, QueueState } from '@shared/queue-types'
import type { AgentStatus, RunSummary, TranscriptItem } from '@shared/runner-types'
import {
  ACTIVE_STATUSES
} from '@shared/queue-types'
import {
  LIMITS,
  jsonBytes,
  requireJobsPage,
  requirePipelineState,
  requirePipelineSummary,
  requireQueueState,
  requireRemoteFile,
  requireRemoteRun,
  requireReviewDetail,
  requireReviewItem,
  requireReviewList,
  requireRunPage,
  requireRunsPage,
  requireStatusSummary,
  requireTranscriptPage,
  truncateUtf8,
  utf8Bytes,
  type PipelineCounts,
  type PipelineState,
  type PipelineStatus,
  type PipelineSummary,
  type RemoteFile,
  type RemoteJob,
  type RemotePage,
  type RemoteQueueItem,
  type RemoteQueueState,
  type RemoteRun,
  type RemoteTranscriptItem,
  type ReviewDetail,
  type ReviewItem,
  type ReviewList,
  type RunPage,
  type StatusSummary
} from '@shared/remote'

/**
 * The one place desktop types become phone DTOs (ADR-0001, "DTO rules"). Every event and
 * every response goes through here, and every projector runs the package's `dto.ts` guard
 * on its output before it is encrypted, so nothing over a `LIMITS` bound and no field the
 * phone does not know (`params`, `pendingReply`, `outputFolder`, …) can leave the Mac.
 */

/** Bytes a page may spend on items: the plaintext budget minus room for the envelope and a run. */
const PAGE_BUDGET = LIMITS.plaintextBytes - 4 * 1024

const title = (s: string): string => (s.length > LIMITS.titleChars ? s.slice(0, LIMITS.titleChars) : s) || 'Untitled'
const errorText = (s: string | undefined): string | undefined => (s === undefined ? undefined : truncateUtf8(s, LIMITS.errorBytes).text)

export function projectRun(run: RunSummary): RemoteRun {
  const { company, role, jobId, source } = run.params
  const job: RemoteRun['job'] = {}
  if (company) job.company = title(company)
  if (role) job.role = title(role)
  if (jobId) job.jobId = jobId.slice(0, LIMITS.jobIdChars)
  if (source) job.source = source.slice(0, 32)
  const out: RemoteRun = {
    id: run.id,
    title: title(run.title),
    agent: run.agent,
    status: run.status,
    job,
    options: { coverLetter: run.params.coverLetter === true, dateStyle: run.params.dateStyle === 'inline' ? 'inline' : 'right' },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    files: (['resume.pdf', 'cover.pdf'] as const).filter((f) => run.outputFiles.includes(f)),
    costUsd: Number.isFinite(run.costUsd) && run.costUsd >= 0 ? run.costUsd : 0,
    live: run.live === true
  }
  if (run.usage) out.usage = { inputTokens: Math.max(0, Math.floor(run.usage.inputTokens)), outputTokens: Math.max(0, Math.floor(run.usage.outputTokens)) }
  const error = errorText(run.error)
  if (error !== undefined) out.error = error
  return requireRemoteRun(out)
}

export function projectQueueItem(item: QueueItem): RemoteQueueItem {
  const out: RemoteQueueItem = {
    id: item.id,
    jobId: item.jobId,
    title: title(item.title),
    agent: item.agent,
    status: item.status,
    runId: item.runId,
    attempts: item.attempts,
    hasPendingReply: typeof item.pendingReply === 'string' && item.pendingReply.length > 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }
  const error = errorText(item.error)
  if (error !== undefined) out.error = error
  if (item.built !== undefined) out.built = item.built
  if (item.notBefore) out.notBefore = item.notBefore
  return out
}

/**
 * Active items first (queued, preparing, running, needs-reply), at most `LIMITS.queueItems`
 * **and** at most `budget` serialised bytes (multibyte titles and JSON-escaped errors count at
 * their wire size); `more` counts the rest. `queue.enqueue` passes a smaller budget because its
 * reply also carries the skipped list.
 */
export function projectQueue(state: QueueState, budget = PAGE_BUDGET): RemoteQueueState {
  const active = state.items.filter((i) => ACTIVE_STATUSES.includes(i.status))
  const rest = state.items.filter((i) => !ACTIVE_STATUSES.includes(i.status))
  const ordered = [...active, ...rest]
  const items: RemoteQueueItem[] = []
  let bytes = 0
  for (const item of ordered.slice(0, LIMITS.queueItems)) {
    const projected = projectQueueItem(item)
    const size = jsonBytes(projected) + 1
    if (bytes + size > budget) break
    items.push(projected)
    bytes += size
  }
  const out: RemoteQueueState = { items, concurrency: state.concurrency, paused: state.paused }
  if (ordered.length > items.length) out.more = ordered.length - items.length
  return requireQueueState(out)
}

export function projectTranscriptItem(item: TranscriptItem): RemoteTranscriptItem {
  const max = LIMITS.transcriptItemTextBytes
  switch (item.kind) {
    case 'tool': {
      const out: RemoteTranscriptItem = {
        kind: 'tool',
        id: item.id,
        name: item.name.slice(0, 128) || 'tool',
        summary: truncateUtf8(item.summary, LIMITS.transcriptSummaryBytes).text,
        status: item.status
      }
      if (item.output !== undefined) {
        const cut = truncateUtf8(item.output, max)
        out.output = cut.text
        if (cut.truncated) out.truncated = true
      }
      return out
    }
    case 'result': {
      const cut = truncateUtf8(item.text, max)
      const out: RemoteTranscriptItem = {
        kind: 'result',
        id: item.id,
        ok: item.ok,
        text: cut.text,
        costUsd: Number.isFinite(item.costUsd) && item.costUsd >= 0 ? item.costUsd : 0,
        durationMs: Number.isInteger(item.durationMs) && item.durationMs >= 0 ? item.durationMs : 0,
        denials: item.denials.slice(0, LIMITS.transcriptDenials).map((d) => d.slice(0, LIMITS.titleChars) || 'denied')
      }
      if (item.usage) out.usage = { inputTokens: Math.max(0, Math.floor(item.usage.inputTokens)), outputTokens: Math.max(0, Math.floor(item.usage.outputTokens)) }
      return out
    }
    case 'notice': {
      const cut = truncateUtf8(item.text, max)
      const out: RemoteTranscriptItem = { kind: 'notice', id: item.id, text: cut.text, level: item.level }
      if (cut.truncated) out.truncated = true
      return out
    }
    default: {
      const cut = truncateUtf8(item.text, max)
      const out: RemoteTranscriptItem = { kind: item.kind, id: item.id, text: cut.text }
      if (cut.truncated) out.truncated = true
      return out
    }
  }
}


/**
 * One page of a transcript from item index `sinceSeq`: at most `LIMITS.transcriptPageItems`
 * items **or** `PAGE_BUDGET` bytes, whichever comes first (twenty 8 KiB items do not fit a
 * frame); `nextSeq` when more follow. A single oversized item still ships alone.
 */
export function pageTranscript(items: readonly TranscriptItem[], sinceSeq = 0): { items: RemoteTranscriptItem[]; nextSeq?: number } {
  const start = Math.max(0, Math.min(sinceSeq, items.length))
  const page: RemoteTranscriptItem[] = []
  let bytes = 0
  let i = start
  for (; i < items.length && page.length < LIMITS.transcriptPageItems; i++) {
    const projected = projectTranscriptItem(items[i])
    const size = jsonBytes(projected) + 1
    if (page.length > 0 && bytes + size > PAGE_BUDGET) break
    page.push(projected)
    bytes += size
  }
  const out: { items: RemoteTranscriptItem[]; nextSeq?: number } = { items: page }
  if (i < items.length) out.nextSeq = i
  return out
}

/** `run.get` result: the run and one page of its transcript. */
export function projectRunPage(run: RunSummary, items: readonly TranscriptItem[], sinceSeq = 0): RunPage {
  const page = pageTranscript(items, sinceSeq)
  const out: RunPage = { run: projectRun(run), items: page.items }
  if (page.nextSeq !== undefined) out.nextSeq = page.nextSeq
  return requireRunPage(out)
}

/** `run.transcript` event body: the items appended since `seq`, one page at a time. */
export function projectTranscriptEvent(runId: string, items: readonly TranscriptItem[], seq: number): { runId: string; items: RemoteTranscriptItem[]; seq: number } {
  return requireTranscriptPage({ runId, items: pageTranscript(items, seq).items, seq })
}

export function projectJob(job: Job): RemoteJob {
  const out: RemoteJob = { id: job.id, title: title(job.title), savedAt: job.postedAt ?? job.fetchedAt }
  if (job.company) out.company = title(job.company)
  if (job.location) out.location = title(job.location)
  if (job.source) out.source = job.source.slice(0, 32)
  if (job.tailoredAt) out.tailored = true
  if (job.dismissed) out.dismissed = true
  return out
}

/**
 * A cursor page over an ordered list: the cursor is the id of the last item of the previous
 * page (stable while items are only added or removed; an unknown cursor restarts at the top).
 * A page stops at `size` items **or** at the plaintext budget (fifty runs with 1 KiB errors
 * do not fit one frame), whichever comes first.
 */
export function pageBy<T, R>(items: readonly T[], idOf: (item: T) => string, cursor: string | undefined, size: number, project: (item: T) => R): RemotePage<R> {
  let start = 0
  if (cursor !== undefined) {
    const at = items.findIndex((i) => idOf(i) === cursor)
    start = at >= 0 ? at + 1 : 0
  }
  const page: R[] = []
  let bytes = 0
  let i = start
  for (; i < items.length && page.length < size; i++) {
    const projected = project(items[i])
    const cost = jsonBytes(projected) + 1
    if (page.length > 0 && bytes + cost > PAGE_BUDGET) break
    page.push(projected)
    bytes += cost
  }
  const out: RemotePage<R> = { items: page }
  if (i < items.length && page.length > 0) out.nextCursor = idOf(items[i - 1]).slice(0, LIMITS.cursorChars)
  return out
}

/**
 * `jobs.list`: the saved jobs as the desktop lists them (canonical, newest posting first),
 * dismissed ones included and flagged (#40), narrowed by `filter` (title, company, location),
 * 50 per page or the plaintext budget.
 */
export function projectJobsPage(jobs: readonly Job[], cursor?: string, filter?: string): RemotePage<RemoteJob> {
  const needle = filter?.trim().toLowerCase()
  const visible = needle ? jobs.filter((j) => `${j.title} ${j.company} ${j.location}`.toLowerCase().includes(needle)) : jobs
  return requireJobsPage(pageBy(visible, (j) => j.id, cursor, LIMITS.jobsPageItems, projectJob))
}

export function projectRunsPage(runs: readonly RunSummary[], cursor?: string): RemotePage<RemoteRun> {
  return requireRunsPage(pageBy(runs, (r) => r.id, cursor, LIMITS.runsPageItems, projectRun))
}

/**
 * Desktop text that may name a file on the Mac (a start error, an agent's message): absolute
 * and home-relative paths are replaced, and the text is cut to `LIMITS.errorBytes`.
 */
export function safeText(s: string): string {
  const scrubbed = s.replace(/(^|[\s('"`=:,])(~?\/[^\s'"`),]*\/[^\s'"`),]*)/g, '$1…')
  return truncateUtf8(scrubbed, LIMITS.errorBytes).text
}

// ── pipeline (#31 → #41) ────────────────────────────────────────────────────────────────────

/**
 * The desktop's statuses onto the phone's closed set: a budget stop is a pause (Resume after
 * raising it on the Mac), and `stopping` is still running until the runs have ended.
 */
const PIPELINE_STATUS: Record<DesktopPipelineState['status'], PipelineStatus> = {
  running: 'running',
  stopping: 'running',
  paused: 'paused',
  'stopped-budget': 'paused',
  'waiting-limit': 'waiting-limit',
  finished: 'finished'
}

/**
 * #31's counts onto the DTO: `done` = built (every result, whatever its review state),
 * `unreviewed` = built and waiting for review; the rest as the desktop panel splits them.
 */
export function projectPipelineCounts(c: DesktopCounts): PipelineCounts {
  return {
    total: c.total,
    done: c.unreviewed + c.needsAttention + c.approved + c.discarded,
    running: c.running,
    queued: c.queued,
    failed: c.failed,
    unreviewed: c.unreviewed,
    needsAttention: c.needsAttention,
    needsReply: c.needsReply,
    cancelled: c.cancelled,
    skipped: c.skipped
  }
}

/** `pipeline.changed` and the result of `pipeline.*`: #31's `PipelineState` for the phone. */
export function projectPipeline(state: DesktopPipelineState, now: number = Date.now()): PipelineState {
  const status = PIPELINE_STATUS[state.status]
  const out: PipelineState = {
    status,
    agent: state.agent,
    counts: projectPipelineCounts(state.counts),
    startedAt: state.startedAt,
    updatedAt: new Date(now).toISOString()
  }
  if (state.until) out.waitingLimitUntil = state.until
  if (state.etaMinutes !== null && status !== 'finished') out.eta = new Date(now + state.etaMinutes * 60_000).toISOString()
  const reason = state.stopReason ?? (state.status === 'waiting-limit' ? state.limitMessage : undefined)
  if (reason) out.reason = safeText(reason)
  return requirePipelineState(out)
}

/** `pipeline.finished`: the summary counts (built / needs review / failed / skipped). */
export function projectPipelineSummary(summary: DesktopPipelineSummary): PipelineSummary {
  const reason = summary.stopReason ?? ''
  return requirePipelineSummary({
    status: !reason ? 'finished' : /^Budget reached/.test(reason) ? 'budget' : 'stopped',
    counts: projectPipelineCounts(summary.counts),
    costUsd: Number.isFinite(summary.costUsd) && summary.costUsd >= 0 ? summary.costUsd : 0,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt
  })
}

// ── review (#31 → #42) ──────────────────────────────────────────────────────────────────────

/** `ReviewItem.runId` / `ReviewDetail.runId` of a result with no recorded run (a fail-closed stand-in). */
export const NO_RUN = 'none'

const isRemoteFile = (file: string): file is RemoteFile => {
  try {
    requireRemoteFile(file)
    return true
  } catch {
    return false
  }
}

/** One row of `review.list` / `review.needed`. */
export function projectReviewItem(item: DesktopReviewItem, openGaps: number): ReviewItem {
  const out: ReviewItem = { applicationId: item.applicationId, runId: item.runId || NO_RUN, title: title(item.title), openGaps: Math.max(0, openGaps), finishedAt: item.at, state: item.state }
  if (item.reason) out.reason = safeText(item.reason)
  return requireReviewItem(out)
}

/** `review.list`: newest first, at most `LIMITS.reviewItems` and the plaintext budget; `more` counts the rest. */
export function projectReviewList(entries: readonly { item: DesktopReviewItem; openGaps: number }[]): ReviewList {
  const items: ReviewItem[] = []
  let bytes = 0
  for (const e of entries.slice(0, LIMITS.reviewItems)) {
    const projected = projectReviewItem(e.item, e.openGaps)
    const size = jsonBytes(projected) + 1
    if (bytes + size > PAGE_BUDGET) break
    items.push(projected)
    bytes += size
  }
  const out: ReviewList = { items }
  if (entries.length > items.length) out.more = entries.length - items.length
  return requireReviewList(out)
}

/**
 * `review.get`: what the desktop's review screen shows, inside the package bounds, under the
 * desktop's own `revision` (sha256 over the full notes, gaps, reframing ids, verify report,
 * every artifact's hash and the review state). What does not fit is marked `truncated`:
 * - a gap or a report is cut; a reframing that does not fit whole is **left out**, never cut,
 *   so the phone can only tick (and approve) a source fact and wording it was shown in full;
 * - the PDFs and every page 1 are listed before further pages;
 * - when the whole detail would not fit one frame, the inline notes go first (the phone then
 *   fetches review-notes.md with `file.get`), then the report, then list entries from the end.
 */
export function projectReviewDetail(d: DesktopReviewDetail): ReviewDetail {
  let truncated = false
  const cut = (text: string, max: number): string => {
    const c = truncateUtf8(text, max)
    if (c.truncated) truncated = true
    return c.text
  }
  const openGaps = d.openGaps.slice(0, LIMITS.reviewListItems).map((g) => cut(g, LIMITS.reviewEntryBytes))
  if (d.openGaps.length > openGaps.length) truncated = true
  const whole = d.proposedReframings.filter((p) => utf8Bytes(p.sourceFact) <= LIMITS.reviewEntryBytes && utf8Bytes(p.wording) <= LIMITS.reviewEntryBytes)
  const proposedReframings = whole.slice(0, LIMITS.reviewListItems).map((p) => ({ id: p.id, sourceFact: p.sourceFact, wording: p.wording }))
  if (d.proposedReframings.length > proposedReframings.length) truncated = true
  const rank = (file: string) => (file.endsWith('.pdf') ? 0 : /-page-1\.jpg$/.test(file) ? 1 : 2)
  const files = d.artifacts.filter((a): a is typeof a & { file: RemoteFile } => isRemoteFile(a.file))
  const artifacts = [...files].sort((a, b) => rank(a.file) - rank(b.file)).slice(0, LIMITS.reviewArtifacts).map((a) => ({ file: a.file, bytes: a.bytes, sha256: a.sha256 }))
  if (d.artifacts.length > artifacts.length) truncated = true
  const out: ReviewDetail = {
    applicationId: d.applicationId,
    runId: d.runId || NO_RUN,
    title: title(d.title),
    reviewNotes: d.reviewNotes !== null && utf8Bytes(d.reviewNotes) <= LIMITS.reviewNotesInlineBytes ? d.reviewNotes : null,
    openGaps,
    proposedReframings,
    verify: { ok: d.verify.ok, report: cut(d.verify.report, LIMITS.verifyReportBytes) },
    artifacts,
    revision: d.revision,
    state: d.state
  }
  if (d.reason) out.reason = safeText(d.reason)
  if (d.parseWarning) out.parseWarning = safeText(d.parseWarning)
  // One frame: JSON escaping can double a text's size, so fit the whole detail to the budget.
  while (jsonBytes(out) > PAGE_BUDGET) {
    if (out.reviewNotes !== null) out.reviewNotes = null
    else if (out.verify.report.length > 0) {
      out.verify.report = truncateUtf8(out.verify.report, Math.floor(utf8Bytes(out.verify.report) / 2)).text
      truncated = true
    } else if (out.proposedReframings.length > 0) {
      out.proposedReframings.pop()
      truncated = true
    } else if (out.openGaps.length > 0) {
      out.openGaps.pop()
      truncated = true
    } else break
  }
  if (truncated) out.truncated = true
  return requireReviewDetail(out)
}

/** `StatusSummary.pipeline`: the status and, while a limit holds, when it resumes. */
export function projectPipelineStatus(state: DesktopPipelineState | null): StatusSummary['pipeline'] {
  if (!state) return null
  const out: NonNullable<StatusSummary['pipeline']> = { status: PIPELINE_STATUS[state.status] }
  if (state.until) out.until = state.until
  return out
}

export interface StatusInput {
  desktopName: string
  appVersion: string
  workspace: { id: string; name: string }
  queue: QueueState
  agents: readonly Pick<AgentStatus, 'id' | 'ready'>[]
  /** #31's pipeline of this workspace (`null` or absent: none, or no pipeline service). */
  pipeline?: DesktopPipelineState | null
  /** Results waiting for review (Unreviewed or Needs attention), #42. */
  unreviewed?: number
}

export function projectStatus(input: StatusInput): StatusSummary {
  const items = input.queue.items
  const out: StatusSummary = {
    desktop: {
      name: title(input.desktopName),
      appVersion: input.appVersion.slice(0, 64) || '0',
      workspaceName: title(input.workspace.name),
      workspaceId: input.workspace.id
    },
    queue: {
      active: items.filter((i) => i.status === 'queued' || i.status === 'preparing' || i.status === 'running').length,
      needsReply: items.filter((i) => i.status === 'needs-reply').length,
      failed: items.filter((i) => i.status === 'failed').length,
      paused: input.queue.paused
    },
    pipeline: projectPipelineStatus(input.pipeline ?? null),
    review: { unreviewed: Math.max(0, Math.floor(input.unreviewed ?? 0)) },
    agents: input.agents.map((a) => ({ id: a.id, ready: a.ready }))
  }
  return requireStatusSummary(out)
}
