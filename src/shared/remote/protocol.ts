/**
 * Wire contract between the desktop, the relay and the phone (ADR-0001, "Message / event
 * schema"). Everything that crosses the wire is defined here and nowhere else: the desktop
 * maps its own types onto these DTOs in `src/main/remote/project.ts`; the phone and the relay
 * import this package. Nothing in this folder imports from the rest of `src/shared`.
 */

import type { LIMITS } from './limits'

/** Protocol majors this build speaks; both sides send it in `hello` and use the highest common one. */
export const PROTOCOL = { min: 1, max: 1 } as const
export type ProtocolRange = { min: number; max: number }
export type ProtocolVersion = 1

/** How long a command may wait for the desktop. Costly ones expire fast (Settings can change the defaults). */
export const COMMAND_TTL_SECONDS = {
  costly: 2 * 60 * 60, // pipeline.start, queue.enqueue, review.approve, review.rerun, run.reply
  default: 24 * 60 * 60 // reads, pause / resume / cancel / retry / stop / finish
} as const

// ── Relay layer (in clear) ───────────────────────────────────────────────────────────────────

/**
 * What the relay sees: one frame on the WebSocket. Everything the relay needs to route,
 * queue, expire and push is here in clear; everything else is inside `ct`.
 */
export interface RelayFrame {
  /** `'desktop'` when sent by a phone; the device id when sent by the desktop. */
  to: 'desktop' | string
  /** = `Envelope.id` for commands; lets the relay report queued / expired. */
  ref: string
  /** 24 bytes, base64. */
  nonce: string
  /** `nacl.box` ciphertext of an `Envelope`, base64; the whole frame stays ≤ `LIMITS.frameBytes`. */
  ct: string
  /** Seconds the relay may hold this frame when the peer is offline. */
  ttl?: number
  /** `ref` of a frame this sender has durably processed: the relay deletes it from the sender's inbox. */
  ack?: string
  /** Desktop → phone only: send one generic push if the phone has no socket. */
  pushHint?: NotificationCategory
  /** Only when "Show details in notifications" is on; ≤ `LIMITS.pushTextChars`, seen by relay/Expo/Apple/Google. */
  pushText?: string
}

/** Relay → client, in clear (the relay generates these). */
export type RelayNotice =
  | { presence: 'online' | 'offline'; since: string; queued: number }
  | { queued: true; ref: string }
  | { expired: true; ref: string }
  | { tooLarge: true; ref: string; bytes: number }

/** Clear frames from a client to the relay after the socket opens (the relay consumes these, nothing is forwarded). */
export type RelayClientFrame =
  | { auth: { room: string; pairing: string } } // phone, during pairing
  | { auth: { room: string; device: string; token: string } } // phone, paired
  | { auth: { room: string; owner: string } } // desktop (ownerSecret)
  | { pushToken: string | null } // phone only, after auth; null removes it
  | { ack: string } // either side, after auth: `ref` of a frame durably processed, with nothing to send back (same effect as `RelayFrame.ack`)

// ── Envelope (the plaintext of one box) ──────────────────────────────────────────────────────

export type EnvelopeKind = 'hello' | 'cmd' | 'result' | 'event' | 'ping' | 'pong'
export type EnvelopeSender = 'desktop' | 'phone'

export type EnvelopeErrorCode = 'unsupported' | 'invalid' | 'stale' | 'denied' | 'rate-limited' | 'expired' | 'failed'
export interface EnvelopeError {
  code: EnvelopeErrorCode
  message: string
}

/** Wire envelope. The whole object is the plaintext of one nacl.box frame (`RelayFrame.ct`). */
export interface Envelope<B = unknown> {
  /** Protocol major; bump on breaking change. */
  v: ProtocolVersion
  /** Session id agreed at pairing (binds frames to this pairing). */
  sid: string
  /** Workspace id; required on every workspace-scoped command, reads included (all but `status.get` and `device.*`). */
  ws?: string
  from: EnvelopeSender
  /** Per sender, per sid, strictly increasing, persisted on both ends (replay guard). */
  seq: number
  /** ISO; the receiver rejects frames older than `ttl`. */
  ts: string
  /** Seconds; same value as `RelayFrame.ttl`, so the desktop re-checks what the relay enforced. */
  ttl: number
  kind: EnvelopeKind
  /** cmd: uuid; result: echoed in `re`. */
  id?: string
  re?: string
  /** cmd / event name. */
  name?: string
  /** result */
  ok?: boolean
  error?: EnvelopeError
  body: B
}

/** Body of a `hello` envelope, the first one on every session in each direction. */
export interface HelloBody {
  protocol: ProtocolRange
  /** Device or desktop name shown to the other side. */
  name: string
  appVersion: string
  /** Desktop → phone: the open workspace (its random id and display name, never the path). */
  workspace?: { id: string; name: string }
}

// ── Enums the phone may send (a desktop test asserts they equal AGENT_IDS, DateStyle, MAX_CONCURRENCY) ──

export const REMOTE_AGENT_IDS = ['claude', 'codex', 'antigravity'] as const
export type RemoteAgentId = (typeof REMOTE_AGENT_IDS)[number]
export const REMOTE_DATE_STYLES = ['inline', 'right'] as const
export type RemoteDateStyle = (typeof REMOTE_DATE_STYLES)[number]
export const REMOTE_MAX_CONCURRENCY = 4
/** Most jobs one `queue.enqueue` or `pipeline.start` may carry (the desktop's `MAX_ENQUEUE`). */
export const REMOTE_MAX_JOBS = 100

export const NOTIFICATION_CATEGORIES = ['needs-reply', 'usage-limit', 'pipeline-finished', 'needs-review', 'failed'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/** Files the phone may fetch, all inside one application folder (resolved with resolveApplicationFile, symlinks refused). */
export type RemoteFile = 'resume.pdf' | 'cover.pdf' | 'review-notes.md' | `resume-page-${number}.jpg` | `cover-page-${number}.jpg`

// ── Commands (phone → desktop) ───────────────────────────────────────────────────────────────

export interface RemoteEnqueueInput {
  /** Saved job ids only, ≤ `REMOTE_MAX_JOBS`. */
  jobIds: string[]
  /** `notes` ≤ `LIMITS.textBytes`. */
  options: { coverLetter: boolean; dateStyle: RemoteDateStyle; notes?: string }
  /** 1..`REMOTE_MAX_CONCURRENCY` */
  concurrency?: number
  agent?: RemoteAgentId
}

/** #31: an unattended pipeline over saved jobs. */
export interface PipelineStartInput {
  jobIds: string[]
  /** 1..`REMOTE_MAX_CONCURRENCY` */
  concurrency: number
  agent: RemoteAgentId
  /** Agent to continue with when `agent` hits a usage limit. */
  fallback?: RemoteAgentId
  /** Stop starting new runs after this many dollars or runs. */
  budget?: { maxCostUsd?: number; maxRuns?: number }
  options?: { coverLetter: boolean; dateStyle: RemoteDateStyle }
}

/** Phone → desktop. The one list: the gateway dispatches only these. */
export type RemoteCommand =
  | { name: 'status.get' }
  | { name: 'queue.get' }
  | { name: 'queue.setPaused'; args: { paused: boolean } }
  | { name: 'queue.cancel'; args: { itemId: string } }
  | { name: 'queue.retry'; args: { itemId: string } }
  | { name: 'queue.enqueue'; args: RemoteEnqueueInput } // package-owned mirror of EnqueueInput; ≤ REMOTE_MAX_JOBS, saved job ids only
  | { name: 'pipeline.start'; args: PipelineStartInput } // #31: jobIds, concurrency 1–4, agent, fallback?, budget?
  | { name: 'pipeline.pause' }
  | { name: 'pipeline.resume' }
  | { name: 'pipeline.stop' }
  | { name: 'jobs.list'; args: { filter?: string; cursor?: string } } // pages of ≤ LIMITS.jobsPageItems
  | { name: 'jobs.addUrl'; args: { url: string } } // same public-host check as the desktop
  | { name: 'runs.list'; args: { cursor?: string } }
  | { name: 'run.get'; args: { runId: string; sinceSeq?: number } } // RemoteRun + one page of ≤ transcriptPageItems items, `nextSeq` when more
  | { name: 'run.reply'; args: { runId: string; text: string } } // ≤ LIMITS.textBytes (the desktop's MAX_TEXT still applies)
  | { name: 'run.finish'; args: { runId: string } }
  | { name: 'run.stop'; args: { runId: string } }
  | { name: 'review.list' } // #31 Unreviewed results
  | { name: 'review.get'; args: { applicationId: string } } // → ReviewDetail: what the desktop review screen shows
  | { name: 'review.approve'; args: { applicationId: string; revision: string; approvedReframingIds?: string[] } }
  | { name: 'review.rerun'; args: { runId: string; revision: string; answers: string } }
  | { name: 'review.discard'; args: { applicationId: string; revision: string } }
  | { name: 'file.get'; args: { applicationId: string; file: RemoteFile; chunk: number } } // chunks of LIMITS.fileChunkBytes
  | { name: 'device.setNotifications'; args: { categories: NotificationCategory[] } }
// The Expo push token is not a command: the phone registers it with the relay in clear (RelayClientFrame).

export type RemoteCommandName = RemoteCommand['name']
export type RemoteCommandArgs<N extends RemoteCommandName> = Extract<RemoteCommand, { name: N }> extends { args: infer A }
  ? A
  : undefined

/** The allow-list, in one place: the gateway dispatches only these names. */
export const REMOTE_COMMAND_NAMES = [
  'status.get',
  'queue.get',
  'queue.setPaused',
  'queue.cancel',
  'queue.retry',
  'queue.enqueue',
  'pipeline.start',
  'pipeline.pause',
  'pipeline.resume',
  'pipeline.stop',
  'jobs.list',
  'jobs.addUrl',
  'runs.list',
  'run.get',
  'run.reply',
  'run.finish',
  'run.stop',
  'review.list',
  'review.get',
  'review.approve',
  'review.rerun',
  'review.discard',
  'file.get',
  'device.setNotifications'
] as const satisfies readonly RemoteCommandName[]

/** Commands that expire after `COMMAND_TTL_SECONDS.costly`; every other command uses `.default`. */
export const COSTLY_COMMANDS = ['pipeline.start', 'queue.enqueue', 'review.approve', 'review.rerun', 'run.reply'] as const satisfies readonly RemoteCommandName[]

/** Commands that need no `Envelope.ws`: `status.get` reports the current workspace, `device.*` is about the phone. */
export const WORKSPACE_FREE_COMMANDS = ['status.get', 'device.setNotifications'] as const satisfies readonly RemoteCommandName[]

/** Reads: no write-ahead audit entry, may be re-executed freely on redelivery. */
export const READ_COMMANDS = ['status.get', 'queue.get', 'jobs.list', 'runs.list', 'run.get', 'review.list', 'review.get', 'file.get'] as const satisfies readonly RemoteCommandName[]

// ── Events (desktop → phone) ─────────────────────────────────────────────────────────────────

/** Desktop → phone. Payloads are the projected DTOs below, never the desktop's own types. */
export type RemoteEvent =
  | { name: 'status'; body: StatusSummary } // heartbeat every 30 s + on change
  | { name: 'queue.changed'; body: RemoteQueueState } // projected from 'queue:changed'
  | { name: 'run.changed'; body: RemoteRun } // projected from 'runner:run'
  | { name: 'run.transcript'; body: { runId: string; items: RemoteTranscriptItem[]; seq: number } }
  | { name: 'pipeline.changed'; body: PipelineState } // #31: counts, waitingLimitUntil, eta
  | { name: 'pipeline.finished'; body: PipelineSummary }
  | { name: 'review.needed'; body: { count: number; latest: ReviewItem } }
  | { name: 'applications.changed'; body: { ids: string[] } }
  | { name: 'file.chunk'; body: FileChunk }
  | { name: 'device.revoked'; body: { reason: string } }

export type RemoteEventName = RemoteEvent['name']
export type RemoteEventBody<N extends RemoteEventName> = Extract<RemoteEvent, { name: N }>['body']

export const REMOTE_EVENT_NAMES = [
  'status',
  'queue.changed',
  'run.changed',
  'run.transcript',
  'pipeline.changed',
  'pipeline.finished',
  'review.needed',
  'applications.changed',
  'file.chunk',
  'device.revoked'
] as const satisfies readonly RemoteEventName[]

/** One piece of a file: `data` = base64 of ≤ `LIMITS.fileChunkBytes`; `sha256` of the whole file, on every chunk. */
export interface FileChunk {
  applicationId: string
  file: RemoteFile
  /** 0-based */
  chunk: number
  /** Number of chunks in the file. */
  of: number
  /** Bytes of the whole file. */
  bytes: number
  /** Hex SHA-256 of the whole file. */
  sha256: string
  data: string
}

// ── DTOs (phone-safe projections; `src/main/remote/project.ts` builds them) ──────────────────

export interface StatusSummary {
  /** Never the workspace path. */
  desktop: { name: string; appVersion: string; workspaceName: string; workspaceId: string }
  queue: { active: number; needsReply: number; failed: number; paused: boolean }
  pipeline: { status: PipelineStatus; until?: string } | null
  review: { unreviewed: number }
  agents: { id: RemoteAgentId; ready: boolean }[]
}

export type PipelineStatus = 'idle' | 'running' | 'paused' | 'waiting-limit' | 'finished'

/** #31: what the Pipeline panel shows. */
export interface PipelineState {
  status: PipelineStatus
  agent: RemoteAgentId
  counts: { total: number; done: number; running: number; queued: number; failed: number; unreviewed: number }
  /** ISO; set while `waiting-limit`. */
  waitingLimitUntil?: string
  /** ISO estimate of when the pipeline finishes. */
  eta?: string
  startedAt: string
  updatedAt: string
}

/** #31: the summary when a pipeline finishes or stops. */
export interface PipelineSummary {
  status: 'finished' | 'stopped' | 'budget'
  counts: PipelineState['counts']
  costUsd: number
  startedAt: string
  finishedAt: string
}

/** One row of the Unreviewed list. */
export interface ReviewItem {
  applicationId: string
  runId: string
  /** "Role · Company" */
  title: string
  /** Number of open gaps, for the badge. */
  openGaps: number
  finishedAt: string
}

/** Everything the desktop review screen (#31) shows, so the phone approves what it has seen. */
export interface ReviewDetail {
  applicationId: string
  runId: string
  /** "Role · Company" */
  title: string
  /** review-notes.md inline when ≤ `LIMITS.reviewNotesInlineBytes`, else null and fetched with file.get. */
  reviewNotes: string | null
  openGaps: string[]
  /** id = sha256(sourceFact + '\n' + wording), stable across calls. */
  proposedReframings: { id: string; sourceFact: string; wording: string }[]
  /** build-report.json / verify.py result, in full. */
  verify: { ok: boolean; report: string }
  /** resume.pdf, cover.pdf, resume-page-N.jpg, cover-page-N.jpg as on disk right now. */
  artifacts: { file: RemoteFile; bytes: number; sha256: string }[]
  /**
   * sha256 over the full review-notes.md, openGaps, reframing ids, verify.report and every artifact's sha256:
   * one immutable snapshot of what the phone was shown. approve / rerun / discard must echo it.
   */
  revision: string
}

export type RemoteRunStatus = 'running' | 'waiting' | 'finished' | 'failed' | 'stopped'

export interface RemoteRun {
  id: string
  title: string
  agent: RemoteAgentId
  status: RemoteRunStatus
  /** From params, minus jobDescription / jobUrl / notes. */
  job: { company?: string; role?: string; jobId?: string; source?: string }
  options: { coverLetter: boolean; dateStyle: RemoteDateStyle }
  createdAt: string
  updatedAt: string
  /** Which outputs exist; never outputFolder or the file list. */
  files: ('resume.pdf' | 'cover.pdf')[]
  costUsd: number
  usage?: { inputTokens: number; outputTokens: number }
  live: boolean
  /** ≤ `LIMITS.errorBytes`, truncated. */
  error?: string
}

export type RemoteQueueItemStatus = 'queued' | 'preparing' | 'running' | 'needs-reply' | 'done' | 'failed' | 'cancelled'

export interface RemoteQueueItem {
  id: string
  jobId: string
  title: string
  agent: RemoteAgentId
  status: RemoteQueueItemStatus
  runId: string | null
  /** ≤ `LIMITS.errorBytes` */
  error?: string
  attempts: number
  built?: boolean
  /** Never the held reply text. */
  hasPendingReply: boolean
  notBefore?: string
  createdAt: string
  updatedAt: string
}

export interface RemoteQueueState {
  /** At most `LIMITS.queueItems`, active items first. */
  items: RemoteQueueItem[]
  concurrency: number
  paused: boolean
  /** Items not included because of `LIMITS.queueItems` (the phone shows "and N more"). */
  more?: number
}

/** TranscriptItem with bounded text: `output` and `text` are cut at `LIMITS.transcriptItemTextBytes` with `truncated: true`. */
export type RemoteTranscriptItem =
  | { kind: 'user' | 'assistant' | 'notice'; id: string; text: string; truncated?: boolean; level?: 'info' | 'error' }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; output?: string; truncated?: boolean }
  | {
      kind: 'result'
      id: string
      ok: boolean
      text: string
      costUsd: number
      durationMs: number
      denials: string[]
      usage?: { inputTokens: number; outputTokens: number }
    }

/** Result body of `run.get`: the run and one page of its transcript. */
export interface RunPage {
  run: RemoteRun
  items: RemoteTranscriptItem[]
  /** Pass as `sinceSeq` to fetch the next page; absent on the last page. */
  nextSeq?: number
}

/** One row of `jobs.list`. */
export interface RemoteJob {
  id: string
  title: string
  company?: string
  location?: string
  source?: string
  tailored?: boolean
  savedAt: string
}

/** Cursor-paged list: `jobs.list` and `runs.list`. */
export interface RemotePage<T> {
  items: T[]
  nextCursor?: string
}

// ── Pairing (secretbox with the QR secret, ADR "Pairing") ───────────────────────────────────

export interface PairHello {
  devicePub: string // base64, 32 bytes
  deviceName: string
  appVersion: string
  protocol: ProtocolRange
}

export interface PairOk {
  deviceId: string
  relayToken: string
  desktopName: string
  protocol: ProtocolRange
  /** Session id both sides put in every `Envelope.sid`. */
  sid: string
}

/** Type-level check that `LIMITS` is the one referenced by the doc comments above. */
export type _Limits = typeof LIMITS
