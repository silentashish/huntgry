import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { Job } from '@shared/jobs-types'
import type { EnqueueResult, QueueState } from '@shared/queue-types'
import type { AgentStatus, RunSummary, TranscriptItem } from '@shared/runner-types'
import {
  COMMAND_TTL_SECONDS,
  LIMITS,
  ProtocolError,
  errorOf,
  isReadCommand,
  requireCommandEnvelope,
  requireFileChunk,
  requireFresh,
  requireNextSeq,
  requireRemoteJob,
  requireWorkspace,
  jsonBytes,
  toBase64,
  ttlFor,
  type Envelope,
  type EnvelopeError,
  type FileChunk,
  type NotificationCategory,
  type RemoteCommand,
  type RemoteCommandName,
  type ReviewDetail,
  type ReviewItem,
  type StatusSummary
} from '@shared/remote'
import type { PipelineState as DesktopPipelineState } from '@shared/pipeline-types'
import type {
  ApproveReviewInput,
  DiscardReviewInput,
  RerunReviewInput,
  ReviewDetail as DesktopReviewDetail,
  ReviewItem as DesktopReviewItem,
  ReviewOutcome,
  ReviewVia
} from '@shared/review-types'
import { isSettledReview } from '../review/service'
import { MAX_TEXT } from '../cli/command'
import { assertPublicUrl, type ResolveHost } from '../cli/public-url'
import { requireRunId } from '../cli/runs'
import { requirePipelineStartInput } from '../pipeline/service'
import { requireEnqueueInput, requireItemId } from '../queue/queue'
import { WorkspaceChangedError } from '../workspace/changed'
import type { AgentId } from '@shared/runner-types'
import { AuditLog, type Known } from './audit'
import type { DeviceRecord, DeviceStore } from './devices'
import { projectJob, projectJobsPage, projectPipeline, projectQueue, projectReviewDetail, projectReviewItem, projectReviewList, projectRun, projectRunPage, projectRunsPage, projectStatus, safeText } from './project'
import type { WorkspaceIdentity } from './workspace'

/**
 * The remote gateway (ADR-0001, "One command round trip", "Commit order on the desktop"):
 * a second caller of the same services the `ipc.ts` files call, reached only through the
 * allow-listed `RemoteCommand` names, with the same validators (`requireRunId`,
 * `requireItemId`, `requireEnqueueInput`, `assertPublicUrl`, `MAX_TEXT`) and one audit log
 * as the durable commit. Electron-free: the session hands it decrypted envelopes, the app
 * hands it the services.
 */

export interface GatewayServices {
  desktopName: string
  appVersion: string
  /** The open workspace with its remote id; throws when none is open. */
  workspace(): Promise<WorkspaceIdentity>
  agents(): Promise<readonly Pick<AgentStatus, 'id' | 'ready'>[]>
  /** The agent new runs use when the phone names none (Settings). */
  defaultAgent(): Promise<AgentId>
  /**
   * Queue and runs take the workspace path the gateway checked as their first argument and act
   * on that workspace only: they throw `WorkspaceChangedError` rather than resolve the open
   * workspace again, so a switch while the command waited cannot redirect it.
   */
  queue: {
    state(workspace: string): Promise<QueueState>
    setPaused(workspace: string, paused: boolean): Promise<QueueState>
    cancel(workspace: string, itemId: string): Promise<QueueState>
    retry(workspace: string, itemId: string): Promise<QueueState>
    /** Takes what `requireEnqueueInput` returned, exactly like `queue/ipc.ts`. */
    enqueue(workspace: string, input: ReturnType<typeof requireEnqueueInput>): Promise<EnqueueResult>
    /** The queue holds a reply for one of its waiting runs; `null` for any other run. */
    reply(workspace: string, runId: string, text: string): Promise<RunSummary | 'held' | null>
  }
  runs: {
    list(workspace: string): Promise<RunSummary[]>
    get(workspace: string, runId: string): Promise<{ run: RunSummary; items: TranscriptItem[] }>
    /** Sends a reply to a run the queue does not manage (the Tailor page's path). */
    reply(workspace: string, runId: string, text: string): Promise<RunSummary>
    stop(workspace: string, runId: string): Promise<RunSummary>
    finish(workspace: string, runId: string): Promise<RunSummary>
  }
  jobs: {
    list(workspace: string): Promise<Job[]>
    /** Fetches a posting page and saves it (after `assertPublicUrl` passed). */
    addUrl(workspace: string, url: string): Promise<Job>
  }
  files: {
    /** Absolute path of a phone-fetchable file, resolved with the applications' safe-path rules. */
    resolve(workspace: string, applicationId: string, file: string): Promise<string>
  }
  /**
   * #31's pipeline (#41): the app's one `Pipeline`, the same methods as the desktop's
   * "Run unattended", Pause, Resume and Stop, each bound to the workspace the gateway checked.
   * Absent (tests, an older wiring): `pipeline.*` answer `unsupported`.
   */
  pipeline?: {
    state(workspace: string): Promise<DesktopPipelineState | null>
    /** Takes what `requirePipelineStartInput` returned, exactly like `pipeline/ipc.ts`. */
    start(workspace: string, input: ReturnType<typeof requirePipelineStartInput>): Promise<DesktopPipelineState>
    pause(workspace: string): Promise<DesktopPipelineState>
    resume(workspace: string): Promise<DesktopPipelineState>
    stop(workspace: string): Promise<DesktopPipelineState>
  }
  /**
   * #31's review service (#42): the desktop's list, detail and decisions, each bound to the
   * workspace the gateway checked; decisions use the desktop's `ReviewDeps` (the same reply
   * path, `afterReviewDecision`). Absent: `review.*` answer `unsupported`.
   */
  review?: {
    list(workspace: string): Promise<{ item: DesktopReviewItem; openGaps: number }[]>
    detail(workspace: string, applicationId: string): Promise<DesktopReviewDetail>
    approve(workspace: string, input: ApproveReviewInput, via: ReviewVia): Promise<ReviewOutcome>
    rerun(workspace: string, input: RerunReviewInput, via: ReviewVia): Promise<ReviewOutcome>
    discard(workspace: string, input: DiscardReviewInput, via: ReviewVia): Promise<ReviewOutcome>
    /** Results waiting for review whose run is done with them (the status count). */
    unreviewed(workspace: string): Promise<number>
  }
  /** Transcripts may be sent to phones (Settings, default on). */
  transcripts(): boolean
  /** DNS for `assertPublicUrl` (tests inject one). */
  resolveHost?: ResolveHost
  now?(): number
  /** Test hook: throw at a step of the commit order to simulate a crash. */
  crashAt?(step: 'before-start' | 'after-start' | 'after-execute' | 'after-finish', name: string): void
}

/** What the session sends back for one delivered frame. */
export interface GatewayReply {
  /** The result envelope to box for the device; `ack` = the command id (or the frame's ref) for the relay. */
  result: Pick<Envelope, 'kind' | 're' | 'ok' | 'error' | 'body' | 'ttl'>
  ack: string
}

/** RUNNER_CHANNELS.reply's message for an unattended run the queue cannot take a reply for right now. */
const UNATTENDED_REPLY = 'This unattended run cannot be continued now. Try again in a moment.'

/** Largest application file a phone may fetch (generated PDFs and notes are far smaller). */
export const MAX_REMOTE_FILE_BYTES = 32 * 1024 * 1024
/** A file chunk waits at the relay at most this long for the phone (#40); the phone asks again. */
export const FILE_CHUNK_TTL_SECONDS = 10 * 60

/** The relay ttl of a result: the command's own, except file chunks (24 KiB each) which are dropped after 10 minutes. */
export function resultTtl(commandTtl: number, name: RemoteCommandName): number {
  return name === 'file.get' ? Math.min(commandTtl, FILE_CHUNK_TTL_SECONDS) : commandTtl
}
const HASH_CACHE_SIZE = 32

/** Plaintext left for a queue projection inside a result envelope (envelope fields take the rest). */
const QUEUE_BUDGET = LIMITS.plaintextBytes - 4 * 1024

const RATE = {
  /** `queue.enqueue` / `pipeline.start`: once per 10 s per device. */
  costlyMs: 10_000,
  /** `run.reply` / `review.rerun`: once per 2 s per run. */
  replyMs: 2_000,
  /** Reads: 30 per minute per device. */
  readsPerMinute: 30
} as const

const REVIEW_COMMANDS: readonly RemoteCommandName[] = ['review.list', 'review.get', 'review.approve', 'review.rerun', 'review.discard']
const PIPELINE_COMMANDS: readonly RemoteCommandName[] = ['pipeline.start', 'pipeline.pause', 'pipeline.resume', 'pipeline.stop']
const UNSUPPORTED = 'Pipelines and reviews are not available on this Mac yet. Update Huntgry.'

/** Revisions remembered per device (a phone looks at a few results, not hundreds). */
const SERVED_PER_DEVICE = 64
const NOT_SERVED = 'This phone was not shown this version of the result. Open it again.'
const UNKNOWN_REFRAMING = 'One of the ticked reframings is not part of this result. Reload it and decide again.'

/** What one device was shown under one revision (`review.get`, or the detail a decision answered with). */
interface Served {
  applicationId: string
  runId: string
  /** The reframing ids listed in full on the phone: the only ones it may approve. */
  ids: Set<string>
}

/** The revision and ids of a review decision, kept in the write-ahead audit entry. */
function auditDetail(command: RemoteCommand): Record<string, unknown> | undefined {
  switch (command.name) {
    case 'review.approve':
      return { applicationId: command.args.applicationId, revision: command.args.revision, ids: command.args.approvedReframingIds ?? [] }
    case 'review.rerun':
      return { runId: command.args.runId, revision: command.args.revision }
    case 'review.discard':
      return { applicationId: command.args.applicationId, revision: command.args.revision }
    default:
      return undefined
  }
}

/**
 * The review list for events (`review.needed`): every listed result as the phone sees it, and
 * whether its run is done with it (not still building, not re-running with the owner's answers).
 */
export async function pendingReviews(s: GatewayServices, workspace: WorkspaceIdentity): Promise<{ item: ReviewItem; settled: boolean }[]> {
  if (!s.review) return []
  return (await s.review.list(workspace.path)).map((e) => ({ item: projectReviewItem(e.item, e.openGaps), settled: isSettledReview(e.item) }))
}

/** "Run unattended"'s defaults when the phone sends no options (BulkTailorModal). */
const PIPELINE_OPTIONS = { coverLetter: true, dateStyle: 'right' } as const

/**
 * A desktop service's own refusal ("A pipeline is already running", a pre-flight blocker) is
 * shown on the phone as it is on the Mac, minus any path; anything else is left to `errorOf`.
 */
async function desktopCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof ProtocolError || err instanceof WorkspaceChangedError || !(err instanceof Error)) throw err
    throw new ProtocolError('failed', safeText(err.message) || 'The command failed on your Mac.')
  }
}

/** The status the phone sees (`status.get`, `hello`, heartbeats): queue, pipeline and agents of `workspace`. */
export async function statusOf(s: GatewayServices, workspace: WorkspaceIdentity): Promise<StatusSummary> {
  const [queue, agents, pipeline, unreviewed] = await Promise.all([
    s.queue.state(workspace.path),
    s.agents(),
    s.pipeline ? s.pipeline.state(workspace.path).catch(() => null) : Promise.resolve(null),
    s.review ? s.review.unreviewed(workspace.path).catch(() => 0) : Promise.resolve(0)
  ])
  return projectStatus({ desktopName: s.desktopName, appVersion: s.appVersion, workspace, queue, agents, pipeline, unreviewed })
}

/** Outcome of `Gateway.admit` for a non-command envelope. */
export type Admission = { status: 'new' | 'redelivered'; device: DeviceRecord } | { status: 'rejected'; error: EnvelopeError }

/** An audit or checkpoint write failed: the frame must stay unacked so the relay redelivers it. */
export class DurabilityError extends Error {
  constructor(readonly cause: unknown) {
    super(`remote state could not be saved: ${(cause as Error)?.message ?? String(cause)}`)
    this.name = 'DurabilityError'
  }
}

async function durable<T>(write: Promise<T>): Promise<T> {
  try {
    return await write
  } catch (err) {
    throw err instanceof DurabilityError ? err : new DurabilityError(err)
  }
}

/**
 * What identifies one delivered envelope: a SHA-256 over every field the phone sealed. The
 * relay redelivers the same ciphertext, so an exact redelivery has the same digest; a reused
 * id with another seq, device session, workspace, name or body does not.
 */
export function envelopeDigest(e: Envelope): string {
  const fields = [e.v, e.sid, e.from, e.seq, e.ts, e.ttl, e.kind, e.id ?? null, e.re ?? null, e.ws ?? null, e.name ?? null, e.ok ?? null, e.error ?? null, e.body ?? null]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

/** Thrown by the `crashAt` test hook: stands for the process dying, so nothing below it runs or is recorded. */
export class SimulatedCrash extends Error {
  constructor(step: string) {
    super(`simulated crash at ${step}`)
    this.name = 'SimulatedCrash'
  }
}

const rateLimited = (message: string): never => {
  throw new ProtocolError('rate-limited', message)
}

export class Gateway {
  private lastCostly = new Map<string, number>()
  private lastReply = new Map<string, number>()
  private reads = new Map<string, number[]>()

  /** One audit log per workspace, loaded on first use. */
  private logs = new Map<string, Promise<AuditLog>>()
  /** Frames of one device are handled in order, so two frames with the same `seq` cannot both pass the check. */
  private chains = new Map<string, Promise<unknown>>()

  constructor(
    private services: GatewayServices,
    private devices: DeviceStore,
    private openAudit: (workspace: string) => AuditLog = AuditLog.forWorkspace
  ) {}

  private now(): number {
    return this.services.now?.() ?? Date.now()
  }

  /**
   * The workspace's audit log. On its first load the log proves each device's `lastSeq`
   * (the checkpoint in `devices.json` never lowers it), so a counter is derived, not trusted.
   */
  auditFor(workspace: string): Promise<AuditLog> {
    let pending = this.logs.get(workspace)
    if (!pending) {
      pending = (async () => {
        const log = this.openAudit(workspace)
        await log.load()
        // Per pairing: a phone paired again under the same id starts its counter over.
        for (const d of this.devices.list()) this.devices.raiseLastSeq(d.id, log.lastSeqOf(d.id, d))
        return log
      })()
      this.logs.set(workspace, pending)
      pending.catch(() => this.logs.delete(workspace))
    }
    return pending
  }

  /**
   * One decrypted envelope from a paired device, through the commit order:
   * (1) freshness, `seq`, `ws` and the allow-list in memory; (2) write-ahead audit entry
   * (fsync) for mutating commands; (3) execute; (4) outcome entry (fsync); (5) the result
   * with `ack`. Redelivered ids are answered from the log without executing.
   */
  handle(device: DeviceRecord, envelope: Envelope): Promise<GatewayReply> {
    const previous = this.chains.get(device.id) ?? Promise.resolve()
    const next = previous.then(
      () => this.handleNow(device, envelope),
      () => this.handleNow(device, envelope)
    )
    this.chains.set(device.id, next.catch(() => undefined))
    return next
  }

  /**
   * The device as the store has it now. A record removed (revoked, unpaired, rotated) or
   * replaced by a new pairing under the same id while this frame waited is `denied`: the
   * caller's copy is never trusted on its own.
   */
  private current(given: DeviceRecord): DeviceRecord {
    const device = this.devices.get(given.id)
    if (!device || device.sid !== given.sid || device.publicKey !== given.publicKey) throw new ProtocolError('denied', 'This phone is no longer paired with this Mac.')
    return device
  }

  /** The command must still be for the workspace it was checked against (the owner may switch during the audit fsync). */
  private async requireSameWorkspace(workspace: WorkspaceIdentity): Promise<void> {
    const now = await this.services.workspace().catch(() => null)
    if (!now || now.path !== workspace.path || now.id !== workspace.id) {
      throw new ProtocolError('invalid', 'The workspace open on the Mac changed; this command was not run.')
    }
  }

  private async handleNow(given: DeviceRecord, envelope: Envelope): Promise<GatewayReply> {
    const id = envelope.id ?? envelope.re ?? 'unknown'
    const ack = id
    const at = new Date(this.now()).toISOString()
    const digest = envelopeDigest(envelope)
    let seq: number | undefined
    let name = typeof envelope.name === 'string' ? envelope.name.slice(0, 64) : 'unknown'
    let audit: AuditLog | null = null
    try {
      if (envelope.kind !== 'cmd' || envelope.id === undefined) throw new ProtocolError('invalid', 'Not a command.')
      requireFresh(envelope, this.now())
      const workspace = await this.services.workspace()
      // An unreadable log is a storage failure: no answer and no ack, never a guess.
      audit = await durable(this.auditFor(workspace.path))
      // The store's record, read after the log raised `lastSeq`; the caller's copy may predate that or a revoke.
      const device = this.current(given)
      if (device.needsRepair) throw new ProtocolError('denied', 'This phone must be paired again.')
      requireWorkspace(envelope, workspace.id)
      const command = requireCommandEnvelope(envelope)
      name = command.name
      // A redelivery is the same frame again: same device, seq and content (digest). Only that is
      // answered from the log; an id reused with anything else is refused and never executes.
      const known = audit.lookup(device.id, envelope.id)
      if (known && (known.seq !== envelope.seq || known.digest !== digest)) {
        throw new ProtocolError('invalid', 'This command id was already used for another command.')
      }
      // A finished read stores no result: its exact redelivery (the result frame was lost) runs the
      // read again under the seq it already used, so it is not a replay and nothing is checkpointed.
      const rerunRead = known?.state === 'finished' && known.read === true && isReadCommand(command.name)
      if (known && !rerunRead) return this.answerKnown(known, envelope, ack)
      if (!rerunRead) {
        try {
          seq = requireNextSeq(envelope.seq, device.lastSeq)
        } catch (err) {
          if (err instanceof ProtocolError && err.code === 'denied') await durable(this.devices.markNeedsRepair(device.id))
          throw err
        }
      }
      // Not checkpointed yet: the audit entry is the commit. A crash before it persists nothing, so
      // the relay's redelivery runs the command exactly once (ADR "Commit order on the desktop").
      if ((REVIEW_COMMANDS.includes(command.name) && !this.services.review) || (PIPELINE_COMMANDS.includes(command.name) && !this.services.pipeline)) {
        throw new ProtocolError('unsupported', UNSUPPORTED)
      }
      this.checkTtl(envelope, command.name)
      this.checkRate(device.id, command)

      if (rerunRead || seq === undefined) {
        await this.requireSameWorkspace(workspace)
        const body = await this.execute(device, command, workspace)
        return { result: { kind: 'result', re: envelope.id, ok: true, body, ttl: resultTtl(envelope.ttl, command.name) }, ack }
      }
      if (isReadCommand(command.name)) {
        await this.requireSameWorkspace(workspace)
        const body = await this.execute(device, command, workspace)
        await durable(audit.finish({ id: envelope.id, deviceId: device.id, sid: device.sid, seq, name: command.name, ok: true, read: true, digest, ts: at }))
        await durable(this.devices.accept(device.id, seq, at))
        return { result: { kind: 'result', re: envelope.id, ok: true, body, ttl: resultTtl(envelope.ttl, command.name) }, ack }
      }

      this.services.crashAt?.('before-start', command.name)
      const detail = auditDetail(command)
      await durable(audit.start({ id: envelope.id, deviceId: device.id, sid: device.sid, seq, name: command.name, digest, ts: at, ...(detail ? { detail } : {}) }))
      await durable(this.devices.accept(device.id, seq, at))
      this.services.crashAt?.('after-start', command.name)
      let body: unknown
      try {
        // Checked again after the fsyncs: a workspace switch during them must not redirect the command.
        await this.requireSameWorkspace(workspace)
        this.current(given)
        body = await this.execute(device, command, workspace)
      } catch (err) {
        if (err instanceof SimulatedCrash) throw err
        const error = errorOf(err)
        if (!(err instanceof ProtocolError)) console.error(`[remote] ${command.name} from ${device.name} failed:`, err)
        await durable(audit.finish({ id: envelope.id, deviceId: device.id, sid: device.sid, seq, name: command.name, ok: false, error, digest }))
        return { result: { kind: 'result', re: envelope.id, ok: false, error, body: null, ttl: envelope.ttl }, ack }
      }
      this.services.crashAt?.('after-execute', command.name)
      await durable(audit.finish({ id: envelope.id, deviceId: device.id, sid: device.sid, seq, name: command.name, ok: true, result: body, digest }))
      this.services.crashAt?.('after-finish', command.name)
      return { result: { kind: 'result', re: envelope.id, ok: true, body, ttl: envelope.ttl }, ack }
    } catch (err) {
      // A crash or a failed audit / checkpoint write: nothing is answered, so the session sends no
      // ack and the relay redelivers the frame once storage works again.
      if (err instanceof SimulatedCrash || err instanceof DurabilityError) throw err
      const error = errorOf(err)
      if (!(err instanceof ProtocolError)) console.error(`[remote] ${name} from ${given.name} failed:`, err)
      // Rejected frames are audited too (device, name, outcome); without a seq when it was never accepted.
      const entry = { id, deviceId: given.id, sid: given.sid, name, ok: false as const, error, ts: at }
      if (audit) await durable(audit.finish(seq === undefined ? entry : { ...entry, seq, digest }))
      if (seq !== undefined) await durable(this.devices.accept(given.id, seq, at))
      return { result: { kind: 'result', re: id, ok: false, error, body: null, ttl: envelope.ttl }, ack }
    }
  }

  /**
   * A non-command envelope from a phone (`hello`, `ping`, `result`, `event`, `pong`) gets the
   * same admission as a command, on the same per-device chain: a current pairing, not marked
   * for re-pair, fresh, and the next `seq`, checkpointed (with its id and digest) before this
   * resolves. An exact redelivery of an admitted frame is recognised; a rewound counter marks
   * the device. Storage failures reject, so the frame is not acked.
   */
  admit(device: DeviceRecord, envelope: Envelope): Promise<Admission> {
    const previous = this.chains.get(device.id) ?? Promise.resolve()
    const next = previous.then(
      () => this.admitNow(device, envelope),
      () => this.admitNow(device, envelope)
    )
    this.chains.set(device.id, next.catch(() => undefined))
    return next
  }

  private async admitNow(given: DeviceRecord, envelope: Envelope): Promise<Admission> {
    try {
      const device = this.current(given)
      if (device.needsRepair) throw new ProtocolError('denied', 'This phone must be paired again.')
      requireFresh(envelope, this.now())
      const frameId = envelope.id ?? ''
      const digest = envelopeDigest(envelope)
      if (envelope.seq <= device.lastSeq && this.devices.admitted(device.id, frameId, digest)) return { status: 'redelivered', device }
      let seq: number
      try {
        seq = requireNextSeq(envelope.seq, device.lastSeq)
      } catch (err) {
        if (err instanceof ProtocolError && err.code === 'denied') await durable(this.devices.markNeedsRepair(device.id))
        throw err
      }
      await durable(this.devices.acceptFrame(device.id, seq, new Date(this.now()).toISOString(), { id: frameId, digest }))
      return { status: 'new', device: this.devices.get(device.id) ?? device }
    } catch (err) {
      if (err instanceof DurabilityError) throw err
      return { status: 'rejected', error: errorOf(err) }
    }
  }

  /**
   * A frame that failed before it was an envelope (bad session, malformed): audited with its
   * ref, never executed. No open workspace means there is no log to write to; a failed write
   * rejects (no ack).
   */
  async recordRejected(device: DeviceRecord, ref: string, error: EnvelopeError): Promise<void> {
    const workspace = await this.services.workspace().catch(() => null)
    if (!workspace) return
    const audit = await durable(this.auditFor(workspace.path))
    await durable(audit.finish({ id: ref, deviceId: device.id, sid: device.sid, name: 'unknown', ok: false, error, ts: new Date(this.now()).toISOString() }))
  }

  /** A redelivered id: finished → the stored result, started → interrupted. */
  private answerKnown(known: Known, envelope: Envelope, ack: string): GatewayReply {
    const re = envelope.id!
    if (known.state === 'started') {
      const error: EnvelopeError = { code: 'failed', message: 'Huntgry was interrupted before this command completed. Check the queue on your Mac and send it again.' }
      return { result: { kind: 'result', re, ok: false, error, body: null, ttl: envelope.ttl }, ack }
    }
    if (known.ok) return { result: { kind: 'result', re, ok: true, body: known.result ?? null, ttl: envelope.ttl }, ack }
    return { result: { kind: 'result', re, ok: false, error: known.error ?? { code: 'failed', message: 'The command failed.' }, body: null, ttl: envelope.ttl }, ack }
  }

  /** The desktop's own copy of the relay's expiry: a costly command older than its class TTL never runs. */
  private checkTtl(envelope: Envelope, name: RemoteCommandName): void {
    const max = ttlFor(name, COMMAND_TTL_SECONDS)
    const age = (this.now() - Date.parse(envelope.ts)) / 1000
    if (age > max) throw new ProtocolError('expired', `${name} was sent ${Math.round(age)} s ago, above its ${max} s limit.`)
  }

  private checkRate(deviceId: string, command: RemoteCommand): void {
    const now = this.now()
    if (isReadCommand(command.name)) {
      const stamps = (this.reads.get(deviceId) ?? []).filter((t) => now - t < 60_000)
      if (stamps.length >= RATE.readsPerMinute) rateLimited(`At most ${RATE.readsPerMinute} reads per minute.`)
      stamps.push(now)
      this.reads.set(deviceId, stamps)
      return
    }
    if (command.name === 'queue.enqueue' || command.name === 'pipeline.start') {
      const last = this.lastCostly.get(deviceId)
      if (last !== undefined && now - last < RATE.costlyMs) rateLimited(`Wait ${Math.ceil((RATE.costlyMs - (now - last)) / 1000)} s before starting more jobs.`)
      this.lastCostly.set(deviceId, now)
      return
    }
    if (command.name === 'run.reply' || command.name === 'review.rerun') {
      const key = `${deviceId}:${command.args.runId}`
      const last = this.lastReply.get(key)
      if (last !== undefined && now - last < RATE.replyMs) rateLimited('One reply every 2 s per run.')
      this.lastReply.set(key, now)
    }
  }

  /** Dispatches an allow-listed, validated command onto the services (the `case` per command the ADR describes). */
  private async execute(device: DeviceRecord, command: RemoteCommand, workspace: WorkspaceIdentity): Promise<unknown> {
    try {
      return await this.dispatch(device, command, workspace)
    } catch (err) {
      if (err instanceof WorkspaceChangedError) throw new ProtocolError('invalid', err.message)
      throw err
    }
  }

  /** Every service call gets `workspace.path` (checked against `Envelope.ws`), never the open workspace. */
  private async dispatch(device: DeviceRecord, command: RemoteCommand, workspace: WorkspaceIdentity): Promise<unknown> {
    const s = this.services
    const ws = workspace.path
    switch (command.name) {
      case 'status.get':
        return statusOf(s, workspace)
      case 'queue.get':
        return projectQueue(await s.queue.state(ws))
      case 'queue.setPaused':
        return projectQueue(await s.queue.setPaused(ws, command.args.paused))
      case 'queue.cancel':
        return projectQueue(await s.queue.cancel(ws, requireItemId(command.args.itemId)))
      case 'queue.retry':
        return projectQueue(await s.queue.retry(ws, requireItemId(command.args.itemId)))
      case 'queue.enqueue': {
        // The package guard bounded jobIds, notes (≤ LIMITS.textBytes) and the enums; the queue's own validator runs too.
        if (command.args.options.notes !== undefined && command.args.options.notes.length > MAX_TEXT) throw new ProtocolError('invalid', 'The notes are too long.')
        const input = requireEnqueueInput(command.args, await s.defaultAgent())
        const result = await s.queue.enqueue(ws, input)
        // At most half the budget for the skipped list (100 jobs × long reasons would not fit); the queue gets the rest.
        const skipped: { jobId: string; reason: string }[] = []
        let skippedBytes = 0
        for (const x of result.skipped) {
          const entry = { jobId: x.jobId, reason: x.reason.slice(0, LIMITS.titleChars) }
          const size = jsonBytes(entry) + 1
          if (skippedBytes + size > QUEUE_BUDGET / 2) break
          skipped.push(entry)
          skippedBytes += size
        }
        return { added: result.added, skipped, queue: projectQueue(result.state, QUEUE_BUDGET - skippedBytes) }
      }
      case 'jobs.list':
        return projectJobsPage(await s.jobs.list(workspace.path), command.args.cursor, command.args.filter)
      case 'jobs.addUrl': {
        // The shape check happened in the package guard; this is the desktop's DNS-resolving public-host check.
        const target = await assertPublicUrl(command.args.url, s.resolveHost).catch((err: Error) => {
          throw new ProtocolError('invalid', safeText(err.message))
        })
        // The desktop's add-by-URL (its loader checks every hop too); its refusals are shown as on the Mac.
        const job = await desktopCall(() => s.jobs.addUrl(ws, target.url.href))
        // The saved job as the Jobs page lists it: under its canonical id when it merged with a copy from another board.
        const canonical = (await s.jobs.list(ws)).find((j) => j.id === job.id || j.aliases?.includes(job.id)) ?? job
        return requireRemoteJob(projectJob(canonical))
      }
      case 'runs.list':
        return projectRunsPage(await s.runs.list(ws), command.args.cursor)
      case 'run.get': {
        const runId = requireRunId(command.args.runId)
        const { run, items } = await s.runs.get(ws, runId)
        return projectRunPage(run, s.transcripts() ? items : [], command.args.sinceSeq ?? 0)
      }
      case 'run.reply': {
        const runId = requireRunId(command.args.runId)
        const text = command.args.text
        // The same rules as RUNNER_CHANNELS.reply: non-empty, at most MAX_TEXT, the queue first,
        // and an unattended run continues only through the queue (process cap, pipeline policy, verify gate).
        if (!text.trim() || text.length > MAX_TEXT) throw new ProtocolError('invalid', 'Type a reply first.')
        const viaQueue = await s.queue.reply(ws, runId, text)
        // Held by the queue until a slot is free (like a desktop reply): the run is unchanged for now.
        if (viaQueue === 'held') return projectRun((await s.runs.get(ws, runId)).run)
        if (viaQueue) return projectRun(viaQueue)
        const { run } = await s.runs.get(ws, runId)
        if (run.unattended || run.params.unattended) throw new ProtocolError('failed', UNATTENDED_REPLY)
        return projectRun(await s.runs.reply(ws, runId, text))
      }
      case 'run.stop':
        return projectRun(await s.runs.stop(ws, requireRunId(command.args.runId)))
      case 'run.finish':
        return projectRun(await s.runs.finish(ws, requireRunId(command.args.runId)))
      case 'file.get':
        return this.fileChunk(workspace.path, command.args)
      case 'device.setNotifications':
        await this.devices.update(device.id, { categories: command.args.categories })
        return { categories: command.args.categories }
      case 'pipeline.start': {
        const pipeline = this.pipeline()
        const input = await this.pipelineInput(command.args)
        return projectPipeline(await desktopCall(() => pipeline.start(ws, input)), this.now())
      }
      case 'pipeline.pause':
        return projectPipeline(await desktopCall(() => this.pipeline().pause(ws)), this.now())
      case 'pipeline.resume':
        return projectPipeline(await desktopCall(() => this.pipeline().resume(ws)), this.now())
      case 'pipeline.stop':
        return projectPipeline(await desktopCall(() => this.pipeline().stop(ws)), this.now())
      case 'review.list':
        return projectReviewList(await desktopCall(() => this.review().list(ws)))
      case 'review.get': {
        const detail = projectReviewDetail(await desktopCall(() => this.review().detail(ws, command.args.applicationId)))
        this.serve(device, detail)
        return detail
      }
      case 'review.approve': {
        const a = command.args
        const served = this.servedFor(device, a.revision, (x) => x.applicationId === a.applicationId)
        const ids = [...new Set(a.approvedReframingIds ?? [])]
        // One id the phone was not shown in full fails the whole command, before anything is written.
        if (ids.some((id) => !served.ids.has(id))) throw new ProtocolError('invalid', UNKNOWN_REFRAMING)
        // The review service rebuilds the detail from disk: a different revision is `stale`; it
        // writes only the on-disk source fact → wording pairs of these ids, clears Unreviewed and
        // calls `afterReviewDecision` (via its deps), exactly like the desktop's Approve.
        const outcome = await desktopCall(() => this.review().approve(ws, { applicationId: a.applicationId, revision: a.revision, approvedReframingIds: ids }, `phone:${device.id}`))
        return this.decided(device, outcome)
      }
      case 'review.rerun': {
        const a = command.args
        const served = this.servedFor(device, a.revision, (x) => x.runId === a.runId)
        const answers = a.answers.trim()
        if (!answers || a.answers.length > MAX_TEXT) throw new ProtocolError('invalid', 'Type your answers first.')
        // The desktop's Re-run: the answers go to the result's own run through the queue (same session, same sandbox).
        const outcome = await desktopCall(() => this.review().rerun(ws, { applicationId: served.applicationId, revision: a.revision, answers, approvedReframingIds: [] }, `phone:${device.id}`))
        return this.decided(device, outcome)
      }
      case 'review.discard': {
        const a = command.args
        this.servedFor(device, a.revision, (x) => x.applicationId === a.applicationId)
        // The desktop's Discard: the result is archived and blocked from Apply; no file is deleted.
        const outcome = await desktopCall(() => this.review().discard(ws, { applicationId: a.applicationId, revision: a.revision }, `phone:${device.id}`))
        return this.decided(device, outcome)
      }
    }
  }

  private review(): NonNullable<GatewayServices['review']> {
    if (!this.services.review) throw new ProtocolError('unsupported', UNSUPPORTED)
    return this.services.review
  }

  /** Revisions served per device and pairing: kept for the gateway's life, so a reconnect does not forget them. */
  private served = new Map<string, Map<string, Served>>()

  private servedKey(device: DeviceRecord): string {
    return `${device.id}\u0000${device.sid}`
  }

  private serve(device: DeviceRecord, detail: ReviewDetail): void {
    const key = this.servedKey(device)
    const map = this.served.get(key) ?? new Map<string, Served>()
    map.delete(detail.revision)
    map.set(detail.revision, { applicationId: detail.applicationId, runId: detail.runId, ids: new Set(detail.proposedReframings.map((p) => p.id)) })
    if (map.size > SERVED_PER_DEVICE) map.delete(map.keys().next().value!)
    this.served.set(key, map)
  }

  /** The detail this device was shown under `revision` (for this result), else `denied`. */
  private servedFor(device: DeviceRecord, revision: string, same: (served: Served) => boolean): Served {
    const served = this.served.get(this.servedKey(device))?.get(revision)
    if (!served || !same(served)) throw new ProtocolError('denied', NOT_SERVED)
    return served
  }

  /** A decision's outcome: `stale` / `invalid` as the service said, else the new detail (served, so the phone can decide again). */
  private decided(device: DeviceRecord, outcome: ReviewOutcome): ReviewDetail {
    if (!outcome.ok) throw new ProtocolError(outcome.error, outcome.message)
    const detail = projectReviewDetail(outcome.detail)
    this.serve(device, detail)
    return detail
  }

  private pipeline(): NonNullable<GatewayServices['pipeline']> {
    if (!this.services.pipeline) throw new ProtocolError('unsupported', UNSUPPORTED)
    return this.services.pipeline
  }

  /**
   * The phone's `PipelineStartInput` (already through the package guard: saved-job id shapes,
   * enum agents, concurrency 1–4, a numeric budget, no other field) onto the desktop's input,
   * then through the desktop's own `requirePipelineStartInput`, exactly as "Run unattended"
   * sends it. Restart, skip and stall options keep the desktop's defaults.
   */
  private async pipelineInput(args: Extract<RemoteCommand, { name: 'pipeline.start' }>['args']): Promise<ReturnType<typeof requirePipelineStartInput>> {
    const budget = args.budget ? { maxCostUsd: args.budget.maxCostUsd, maxJobs: args.budget.maxRuns } : undefined
    try {
      return requirePipelineStartInput(
        {
          jobIds: args.jobIds,
          options: args.options ?? PIPELINE_OPTIONS,
          agent: args.agent,
          concurrency: args.concurrency,
          ...(args.fallback ? { fallbackAgent: args.fallback } : {}),
          ...(budget ? { budget } : {})
        },
        await this.services.defaultAgent()
      )
    } catch (err) {
      throw new ProtocolError('invalid', safeText((err as Error).message))
    }
  }

  /** Whole-file SHA-256 per file identity (path, size, mtime, inode), so chunks 2…n do not hash the file again. */
  private hashes = new Map<string, Promise<string>>()

  /**
   * One `LIMITS.fileChunkBytes` piece of an application file, with the whole file's SHA-256 on
   * every chunk. The size is checked (and the chunk index refused) before anything is read; only
   * the requested range is read; the hash is streamed once per file version.
   */
  private async fileChunk(workspace: string, args: { applicationId: string; file: string; chunk: number }): Promise<FileChunk> {
    let path: string
    let handle: FileHandle
    try {
      // The applications' safe-path rules (#24): an id inside the workspace, a real folder, a known
      // regular file, symlinks refused. The package guard already allowed only the phone's file names.
      path = await this.services.files.resolve(workspace, args.applicationId, args.file)
      // O_NOFOLLOW: a symlink swapped in after the check is refused, never followed.
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (err) {
      if (err instanceof WorkspaceChangedError || err instanceof ProtocolError) throw err
      throw new ProtocolError('invalid', `${args.file} of this application cannot be sent: it does not exist, or it is not a regular file inside the workspace.`)
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new ProtocolError('invalid', 'This file cannot be sent.')
      if (info.size > MAX_REMOTE_FILE_BYTES) throw new ProtocolError('invalid', `This file is larger than ${MAX_REMOTE_FILE_BYTES / (1024 * 1024)} MB and cannot be sent to the phone.`)
      const size = LIMITS.fileChunkBytes
      const of = Math.max(1, Math.ceil(info.size / size))
      if (args.chunk >= of) throw new ProtocolError('invalid', `This file has ${of} chunks.`)
      const start = args.chunk * size
      const length = Math.min(size, info.size - start)
      const piece = Buffer.alloc(Math.max(0, length))
      let read = 0
      while (read < piece.length) {
        const { bytesRead } = await handle.read(piece, read, piece.length - read, start + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      const sha256 = await this.fileHash(handle, info.size, `${path}\u0000${info.size}\u0000${info.mtimeMs}\u0000${info.ino}`)
      return requireFileChunk({
        applicationId: args.applicationId,
        file: args.file,
        chunk: args.chunk,
        of,
        bytes: info.size,
        sha256,
        data: toBase64(new Uint8Array(piece.subarray(0, read)))
      })
    } finally {
      await handle.close()
    }
  }

  /** Hashes the file through the handle already opened (the bytes the chunks come from), never by path again. */
  private fileHash(handle: FileHandle, size: number, identity: string): Promise<string> {
    const cached = this.hashes.get(identity)
    if (cached) return cached
    const pending = (async () => {
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(Math.min(Math.max(size, 1), 256 * 1024))
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
      return hash.digest('hex')
    })()
    this.hashes.set(identity, pending)
    pending.catch(() => this.hashes.delete(identity))
    if (this.hashes.size > HASH_CACHE_SIZE) this.hashes.delete(this.hashes.keys().next().value!)
    return pending
  }
}

/** Categories an event maps to for push hints (ADR "How a push happens"). */
export function categoryOf(event: { name: string; body: unknown }): NotificationCategory | null {
  switch (event.name) {
    case 'run.changed': {
      const run = event.body as { status?: string; error?: string }
      if (run.status === 'waiting') return 'needs-reply'
      if (run.status === 'failed') return /usage limit|rate.?limit|quota|\b429\b/i.test(run.error ?? '') ? 'usage-limit' : 'failed'
      return null
    }
    case 'pipeline.finished':
      return 'pipeline-finished'
    case 'review.needed':
      return 'needs-review'
    default:
      return null
  }
}
