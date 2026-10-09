/**
 * Field-by-field validation of every DTO that travels desktop → phone (event bodies and the
 * bodies of `run.get`, `queue.get`, `review.get`, `status.get`, `jobs.list`, `runs.list`
 * results). The phone runs these before rendering; the desktop's projector runs them before
 * encrypting, so no producer can send more than the phone accepts (ADR-0001, "DTO rules").
 * Every text field has a bound from `LIMITS`, every list a maximum length, and unknown
 * fields are refused.
 */

import { LIMITS, utf8Bytes } from './limits'
import {
  invalid,
  rejectUnknownKeys,
  requireAgentId,
  requireApplicationId,
  base64DecodedBytes,
  requireBase64,
  requireBoolean,
  requireConcurrency,
  requireCursor,
  requireDateStyle,
  requireId,
  requireInteger,
  requireIsoDate,
  requireJobId,
  requireNumber,
  requireOneOf,
  requireRecord,
  requireRemoteFile,
  requireShortString,
  requireStringArray
} from './check'
import {
  REMOTE_AGENT_IDS,
  type FileChunk,
  type PipelineCounts,
  type PipelineState,
  type PipelineSummary,
  type RemoteEvent,
  type RemoteEventName,
  type RemoteJob,
  type RemotePage,
  type RemoteQueueItem,
  type RemoteQueueState,
  type RemoteRun,
  type RemoteTranscriptItem,
  type ReviewDetail,
  type ReviewItem,
  type RunPage,
  type StatusSummary
} from './protocol'

const RUN_STATUSES = ['running', 'waiting', 'finished', 'failed', 'stopped'] as const
const QUEUE_STATUSES = ['queued', 'preparing', 'running', 'needs-reply', 'done', 'failed', 'cancelled'] as const
const PIPELINE_STATUSES = ['idle', 'running', 'paused', 'waiting-limit', 'finished'] as const
const TOOL_STATUSES = ['running', 'ok', 'error'] as const
const LEVELS = ['info', 'error'] as const
const RUN_FILES = ['resume.pdf', 'cover.pdf'] as const
const SHA256_RE = /^[0-9a-f]{64}$/

/** A label: non-empty, at most `LIMITS.titleChars` characters. */
function requireTitle(v: unknown, what: string): string {
  return requireId(v, what, LIMITS.titleChars)
}

/** Bounded text that may be empty (transcript text, tool output, review notes). */
function requireBoundedText(v: unknown, what: string, maxBytes: number): string {
  if (typeof v !== 'string') invalid(`${what} must be a string.`)
  if (utf8Bytes(v as string) > maxBytes) invalid(`${what} exceeds ${maxBytes} bytes.`)
  return v as string
}

function requireError(v: unknown, what: string): string {
  return requireBoundedText(v, what, LIMITS.errorBytes)
}

function requireUsage(v: unknown, what: string): { inputTokens: number; outputTokens: number } {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['inputTokens', 'outputTokens'], what)
  return { inputTokens: requireInteger(r.inputTokens, `${what}.inputTokens`, 0), outputTokens: requireInteger(r.outputTokens, `${what}.outputTokens`, 0) }
}

function requireSha256(v: unknown, what: string): string {
  if (typeof v !== 'string' || !SHA256_RE.test(v)) invalid(`${what} must be 64 hex characters.`)
  return v as string
}

function requireList<T>(v: unknown, what: string, maxItems: number, item: (x: unknown, at: string) => T): T[] {
  if (!Array.isArray(v) || v.length > maxItems) invalid(`${what} must be an array of at most ${maxItems} items.`)
  return (v as unknown[]).map((x, i) => item(x, `${what}[${i}]`))
}

// ── status ──────────────────────────────────────────────────────────────────────────────────

export function requireStatusSummary(v: unknown): StatusSummary {
  const r = requireRecord(v, 'status')
  rejectUnknownKeys(r, ['desktop', 'queue', 'pipeline', 'review', 'agents'], 'status')
  const d = requireRecord(r.desktop, 'status.desktop')
  rejectUnknownKeys(d, ['name', 'appVersion', 'workspaceName', 'workspaceId'], 'status.desktop')
  const q = requireRecord(r.queue, 'status.queue')
  rejectUnknownKeys(q, ['active', 'needsReply', 'failed', 'paused'], 'status.queue')
  const rv = requireRecord(r.review, 'status.review')
  rejectUnknownKeys(rv, ['unreviewed'], 'status.review')
  let pipeline: StatusSummary['pipeline'] = null
  if (r.pipeline !== null) {
    const p = requireRecord(r.pipeline, 'status.pipeline')
    rejectUnknownKeys(p, ['status', 'until'], 'status.pipeline')
    pipeline = { status: requireOneOf(p.status, PIPELINE_STATUSES, 'status.pipeline.status') }
    if (p.until !== undefined) pipeline.until = requireIsoDate(p.until, 'status.pipeline.until')
  }
  const agents = requireList(r.agents, 'status.agents', REMOTE_AGENT_IDS.length, (a, at) => {
    const x = requireRecord(a, at)
    rejectUnknownKeys(x, ['id', 'ready'], at)
    return { id: requireAgentId(x.id, `${at}.id`), ready: requireBoolean(x.ready, `${at}.ready`) }
  })
  return {
    desktop: {
      name: requireTitle(d.name, 'status.desktop.name'),
      appVersion: requireId(d.appVersion, 'status.desktop.appVersion', 64),
      workspaceName: requireTitle(d.workspaceName, 'status.desktop.workspaceName'),
      workspaceId: requireId(d.workspaceId, 'status.desktop.workspaceId')
    },
    queue: {
      active: requireInteger(q.active, 'status.queue.active', 0),
      needsReply: requireInteger(q.needsReply, 'status.queue.needsReply', 0),
      failed: requireInteger(q.failed, 'status.queue.failed', 0),
      paused: requireBoolean(q.paused, 'status.queue.paused')
    },
    pipeline,
    review: { unreviewed: requireInteger(rv.unreviewed, 'status.review.unreviewed', 0) },
    agents
  }
}

// ── runs and queue ──────────────────────────────────────────────────────────────────────────

export function requireRemoteRun(v: unknown, what = 'run'): RemoteRun {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['id', 'title', 'agent', 'status', 'job', 'options', 'createdAt', 'updatedAt', 'files', 'costUsd', 'usage', 'live', 'error'], what)
  const j = requireRecord(r.job, `${what}.job`)
  rejectUnknownKeys(j, ['company', 'role', 'jobId', 'source'], `${what}.job`)
  const o = requireRecord(r.options, `${what}.options`)
  rejectUnknownKeys(o, ['coverLetter', 'dateStyle'], `${what}.options`)
  const job: RemoteRun['job'] = {}
  if (j.company !== undefined) job.company = requireTitle(j.company, `${what}.job.company`)
  if (j.role !== undefined) job.role = requireTitle(j.role, `${what}.job.role`)
  if (j.jobId !== undefined) job.jobId = requireJobId(j.jobId, `${what}.job.jobId`)
  if (j.source !== undefined) job.source = requireId(j.source, `${what}.job.source`, 32)
  const files = requireList(r.files, `${what}.files`, RUN_FILES.length, (f, at) => requireOneOf(f, RUN_FILES, at))
  const out: RemoteRun = {
    id: requireId(r.id, `${what}.id`),
    title: requireTitle(r.title, `${what}.title`),
    agent: requireAgentId(r.agent, `${what}.agent`),
    status: requireOneOf(r.status, RUN_STATUSES, `${what}.status`),
    job,
    options: { coverLetter: requireBoolean(o.coverLetter, `${what}.options.coverLetter`), dateStyle: requireDateStyle(o.dateStyle, `${what}.options.dateStyle`) },
    createdAt: requireIsoDate(r.createdAt, `${what}.createdAt`),
    updatedAt: requireIsoDate(r.updatedAt, `${what}.updatedAt`),
    files,
    costUsd: requireNumber(r.costUsd, `${what}.costUsd`),
    live: requireBoolean(r.live, `${what}.live`)
  }
  if (r.usage !== undefined) out.usage = requireUsage(r.usage, `${what}.usage`)
  if (r.error !== undefined) out.error = requireError(r.error, `${what}.error`)
  return out
}

export function requireQueueItem(v: unknown, what = 'item'): RemoteQueueItem {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['id', 'jobId', 'title', 'agent', 'status', 'runId', 'error', 'attempts', 'built', 'hasPendingReply', 'notBefore', 'createdAt', 'updatedAt'], what)
  if (r.runId !== null) requireId(r.runId, `${what}.runId`)
  const out: RemoteQueueItem = {
    id: requireId(r.id, `${what}.id`),
    jobId: requireJobId(r.jobId, `${what}.jobId`),
    title: requireTitle(r.title, `${what}.title`),
    agent: requireAgentId(r.agent, `${what}.agent`),
    status: requireOneOf(r.status, QUEUE_STATUSES, `${what}.status`),
    runId: r.runId as string | null,
    attempts: requireInteger(r.attempts, `${what}.attempts`, 0),
    hasPendingReply: requireBoolean(r.hasPendingReply, `${what}.hasPendingReply`),
    createdAt: requireIsoDate(r.createdAt, `${what}.createdAt`),
    updatedAt: requireIsoDate(r.updatedAt, `${what}.updatedAt`)
  }
  if (r.error !== undefined) out.error = requireError(r.error, `${what}.error`)
  if (r.built !== undefined) out.built = requireBoolean(r.built, `${what}.built`)
  if (r.notBefore !== undefined) out.notBefore = requireIsoDate(r.notBefore, `${what}.notBefore`)
  return out
}

export function requireQueueState(v: unknown, what = 'queue'): RemoteQueueState {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['items', 'concurrency', 'paused', 'more'], what)
  const out: RemoteQueueState = {
    items: requireList(r.items, `${what}.items`, LIMITS.queueItems, (x, at) => requireQueueItem(x, at)),
    concurrency: requireConcurrency(r.concurrency, `${what}.concurrency`),
    paused: requireBoolean(r.paused, `${what}.paused`)
  }
  if (r.more !== undefined) out.more = requireInteger(r.more, `${what}.more`, 0)
  return out
}

export function requireTranscriptItem(v: unknown, what = 'item'): RemoteTranscriptItem {
  const r = requireRecord(v, what)
  const kind = requireOneOf(r.kind, ['user', 'assistant', 'notice', 'tool', 'result'] as const, `${what}.kind`)
  const id = requireId(r.id, `${what}.id`)
  const max = LIMITS.transcriptItemTextBytes
  if (kind === 'tool') {
    rejectUnknownKeys(r, ['kind', 'id', 'name', 'summary', 'status', 'output', 'truncated'], what)
    const out: RemoteTranscriptItem = { kind, id, name: requireId(r.name, `${what}.name`, 128), summary: requireBoundedText(r.summary, `${what}.summary`, LIMITS.transcriptSummaryBytes), status: requireOneOf(r.status, TOOL_STATUSES, `${what}.status`) }
    if (r.output !== undefined) out.output = requireBoundedText(r.output, `${what}.output`, max)
    if (r.truncated !== undefined) out.truncated = requireBoolean(r.truncated, `${what}.truncated`)
    return out
  }
  if (kind === 'result') {
    rejectUnknownKeys(r, ['kind', 'id', 'ok', 'text', 'costUsd', 'durationMs', 'denials', 'usage'], what)
    const out: RemoteTranscriptItem = {
      kind,
      id,
      ok: requireBoolean(r.ok, `${what}.ok`),
      text: requireBoundedText(r.text, `${what}.text`, max),
      costUsd: requireNumber(r.costUsd, `${what}.costUsd`),
      durationMs: requireInteger(r.durationMs, `${what}.durationMs`, 0),
      denials: requireStringArray(r.denials, `${what}.denials`, LIMITS.transcriptDenials, LIMITS.titleChars)
    }
    if (r.usage !== undefined) out.usage = requireUsage(r.usage, `${what}.usage`)
    return out
  }
  rejectUnknownKeys(r, ['kind', 'id', 'text', 'truncated', 'level'], what)
  const out: RemoteTranscriptItem = { kind, id, text: requireBoundedText(r.text, `${what}.text`, max) }
  if (r.truncated !== undefined) out.truncated = requireBoolean(r.truncated, `${what}.truncated`)
  if (r.level !== undefined) out.level = requireOneOf(r.level, LEVELS, `${what}.level`)
  return out
}

/** `run.transcript` body: at most `LIMITS.transcriptPageItems` items per page. */
export function requireTranscriptPage(v: unknown, what = 'run.transcript'): { runId: string; items: RemoteTranscriptItem[]; seq: number } {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['runId', 'items', 'seq'], what)
  return {
    runId: requireId(r.runId, `${what}.runId`),
    items: requireList(r.items, `${what}.items`, LIMITS.transcriptPageItems, (x, at) => requireTranscriptItem(x, at)),
    seq: requireInteger(r.seq, `${what}.seq`, 0)
  }
}

/** `run.get` result body. */
export function requireRunPage(v: unknown, what = 'run.get'): RunPage {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['run', 'items', 'nextSeq'], what)
  const out: RunPage = {
    run: requireRemoteRun(r.run, `${what}.run`),
    items: requireList(r.items, `${what}.items`, LIMITS.transcriptPageItems, (x, at) => requireTranscriptItem(x, at))
  }
  if (r.nextSeq !== undefined) out.nextSeq = requireInteger(r.nextSeq, `${what}.nextSeq`, 0)
  return out
}

// ── pipeline (#31) ──────────────────────────────────────────────────────────────────────────

const COUNT_KEYS = ['total', 'done', 'running', 'queued', 'failed', 'unreviewed'] as const
const OPTIONAL_COUNT_KEYS = ['needsAttention', 'needsReply', 'cancelled', 'skipped'] as const

function requireCounts(v: unknown, what: string): PipelineCounts {
  const c = requireRecord(v, what)
  rejectUnknownKeys(c, [...COUNT_KEYS, ...OPTIONAL_COUNT_KEYS], what)
  const out = {} as PipelineCounts
  for (const k of COUNT_KEYS) out[k] = requireInteger(c[k], `${what}.${k}`, 0)
  for (const k of OPTIONAL_COUNT_KEYS) if (c[k] !== undefined) out[k] = requireInteger(c[k], `${what}.${k}`, 0)
  return out
}

export function requirePipelineState(v: unknown, what = 'pipeline.changed'): PipelineState {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['status', 'agent', 'counts', 'waitingLimitUntil', 'eta', 'reason', 'startedAt', 'updatedAt'], what)
  const out: PipelineState = {
    status: requireOneOf(r.status, PIPELINE_STATUSES, `${what}.status`),
    agent: requireAgentId(r.agent, `${what}.agent`),
    counts: requireCounts(r.counts, `${what}.counts`),
    startedAt: requireIsoDate(r.startedAt, `${what}.startedAt`),
    updatedAt: requireIsoDate(r.updatedAt, `${what}.updatedAt`)
  }
  if (r.waitingLimitUntil !== undefined) out.waitingLimitUntil = requireIsoDate(r.waitingLimitUntil, `${what}.waitingLimitUntil`)
  if (r.eta !== undefined) out.eta = requireIsoDate(r.eta, `${what}.eta`)
  if (r.reason !== undefined) out.reason = requireError(r.reason, `${what}.reason`)
  return out
}

export function requirePipelineSummary(v: unknown, what = 'pipeline.finished'): PipelineSummary {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['status', 'counts', 'costUsd', 'startedAt', 'finishedAt'], what)
  return {
    status: requireOneOf(r.status, ['finished', 'stopped', 'budget'] as const, `${what}.status`),
    counts: requireCounts(r.counts, `${what}.counts`),
    costUsd: requireNumber(r.costUsd, `${what}.costUsd`),
    startedAt: requireIsoDate(r.startedAt, `${what}.startedAt`),
    finishedAt: requireIsoDate(r.finishedAt, `${what}.finishedAt`)
  }
}

// ── review ──────────────────────────────────────────────────────────────────────────────────

export function requireReviewItem(v: unknown, what = 'review'): ReviewItem {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['applicationId', 'runId', 'title', 'openGaps', 'finishedAt'], what)
  return {
    applicationId: requireApplicationId(r.applicationId, `${what}.applicationId`),
    runId: requireId(r.runId, `${what}.runId`),
    title: requireTitle(r.title, `${what}.title`),
    openGaps: requireInteger(r.openGaps, `${what}.openGaps`, 0),
    finishedAt: requireIsoDate(r.finishedAt, `${what}.finishedAt`)
  }
}

/** `review.get` result body: notes inline only up to `LIMITS.reviewNotesInlineBytes`. */
export function requireReviewDetail(v: unknown, what = 'review.get'): ReviewDetail {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['applicationId', 'runId', 'title', 'reviewNotes', 'openGaps', 'proposedReframings', 'verify', 'artifacts', 'revision'], what)
  const verify = requireRecord(r.verify, `${what}.verify`)
  rejectUnknownKeys(verify, ['ok', 'report'], `${what}.verify`)
  return {
    applicationId: requireApplicationId(r.applicationId, `${what}.applicationId`),
    runId: requireId(r.runId, `${what}.runId`),
    title: requireTitle(r.title, `${what}.title`),
    reviewNotes: r.reviewNotes === null ? null : requireBoundedText(r.reviewNotes, `${what}.reviewNotes`, LIMITS.reviewNotesInlineBytes),
    openGaps: requireList(r.openGaps, `${what}.openGaps`, LIMITS.reviewListItems, (g, at) => requireBoundedText(g, at, LIMITS.reviewEntryBytes)),
    proposedReframings: requireList(r.proposedReframings, `${what}.proposedReframings`, LIMITS.reviewListItems, (p, at) => {
      const x = requireRecord(p, at)
      rejectUnknownKeys(x, ['id', 'sourceFact', 'wording'], at)
      return { id: requireSha256(x.id, `${at}.id`), sourceFact: requireBoundedText(x.sourceFact, `${at}.sourceFact`, LIMITS.reviewEntryBytes), wording: requireBoundedText(x.wording, `${at}.wording`, LIMITS.reviewEntryBytes) }
    }),
    verify: { ok: requireBoolean(verify.ok, `${what}.verify.ok`), report: requireBoundedText(verify.report, `${what}.verify.report`, LIMITS.verifyReportBytes) },
    artifacts: requireList(r.artifacts, `${what}.artifacts`, LIMITS.reviewArtifacts, (a, at) => {
      const x = requireRecord(a, at)
      rejectUnknownKeys(x, ['file', 'bytes', 'sha256'], at)
      return { file: requireRemoteFile(x.file, `${at}.file`), bytes: requireInteger(x.bytes, `${at}.bytes`, 0), sha256: requireSha256(x.sha256, `${at}.sha256`) }
    }),
    revision: requireSha256(r.revision, `${what}.revision`)
  }
}

// ── jobs, pages, files ──────────────────────────────────────────────────────────────────────

export function requireRemoteJob(v: unknown, what = 'job'): RemoteJob {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['id', 'title', 'company', 'location', 'source', 'tailored', 'savedAt'], what)
  const out: RemoteJob = { id: requireJobId(r.id, `${what}.id`), title: requireTitle(r.title, `${what}.title`), savedAt: requireIsoDate(r.savedAt, `${what}.savedAt`) }
  if (r.company !== undefined) out.company = requireTitle(r.company, `${what}.company`)
  if (r.location !== undefined) out.location = requireTitle(r.location, `${what}.location`)
  if (r.source !== undefined) out.source = requireId(r.source, `${what}.source`, 32)
  if (r.tailored !== undefined) out.tailored = requireBoolean(r.tailored, `${what}.tailored`)
  return out
}

/** A cursor page: `jobs.list` (≤ `LIMITS.jobsPageItems` jobs) or `runs.list` (≤ `LIMITS.runsPageItems` runs). */
export function requirePage<T>(v: unknown, what: string, maxItems: number, item: (x: unknown, at: string) => T): RemotePage<T> {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['items', 'nextCursor'], what)
  const out: RemotePage<T> = { items: requireList(r.items, `${what}.items`, maxItems, item) }
  if (r.nextCursor !== undefined) out.nextCursor = requireCursor(r.nextCursor, `${what}.nextCursor`)
  return out
}

export const requireJobsPage = (v: unknown): RemotePage<RemoteJob> => requirePage(v, 'jobs.list', LIMITS.jobsPageItems, (x, at) => requireRemoteJob(x, at))
export const requireRunsPage = (v: unknown): RemotePage<RemoteRun> => requirePage(v, 'runs.list', LIMITS.runsPageItems, (x, at) => requireRemoteRun(x, at))

export function requireFileChunk(v: unknown, what = 'file.chunk'): FileChunk {
  const r = requireRecord(v, what)
  rejectUnknownKeys(r, ['applicationId', 'file', 'chunk', 'of', 'bytes', 'sha256', 'data'], what)
  const of = requireInteger(r.of, `${what}.of`, 1, 100_000)
  const data = requireBase64(r.data, `${what}.data`)
  if (base64DecodedBytes(data) > LIMITS.fileChunkBytes) invalid(`${what}.data exceeds ${LIMITS.fileChunkBytes} bytes.`)
  return {
    applicationId: requireApplicationId(r.applicationId, `${what}.applicationId`),
    file: requireRemoteFile(r.file, `${what}.file`),
    chunk: requireInteger(r.chunk, `${what}.chunk`, 0, of - 1),
    of,
    bytes: requireInteger(r.bytes, `${what}.bytes`, 0),
    sha256: requireSha256(r.sha256, `${what}.sha256`),
    data
  }
}

// ── the event switch ────────────────────────────────────────────────────────────────────────

/** The body of a known event, validated against its DTO. `requireEvent` checks the name first. */
export function requireEventBody(name: RemoteEventName, body: unknown): RemoteEvent {
  switch (name) {
    case 'status':
      return { name, body: requireStatusSummary(body) }
    case 'queue.changed':
      return { name, body: requireQueueState(body, name) }
    case 'run.changed':
      return { name, body: requireRemoteRun(body, name) }
    case 'run.transcript':
      return { name, body: requireTranscriptPage(body, name) }
    case 'pipeline.changed':
      return { name, body: requirePipelineState(body, name) }
    case 'pipeline.finished':
      return { name, body: requirePipelineSummary(body, name) }
    case 'review.needed': {
      const r = requireRecord(body, name)
      rejectUnknownKeys(r, ['count', 'latest'], name)
      return { name, body: { count: requireInteger(r.count, `${name}.count`, 0), latest: requireReviewItem(r.latest, `${name}.latest`) } }
    }
    case 'applications.changed': {
      const r = requireRecord(body, name)
      rejectUnknownKeys(r, ['ids'], name)
      return { name, body: { ids: requireStringArray(r.ids, `${name}.ids`, LIMITS.applicationsChangedIds, LIMITS.applicationIdChars) } }
    }
    case 'file.chunk':
      return { name, body: requireFileChunk(body, name) }
    case 'device.revoked': {
      const r = requireRecord(body, name)
      rejectUnknownKeys(r, ['reason'], name)
      return { name, body: { reason: requireShortString(r.reason, `${name}.reason`) } }
    }
  }
}
