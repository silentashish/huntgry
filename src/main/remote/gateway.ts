import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
  requireWorkspace,
  toBase64,
  ttlFor,
  type Envelope,
  type EnvelopeError,
  type FileChunk,
  type NotificationCategory,
  type RemoteCommand,
  type RemoteCommandName
} from '@shared/remote'
import { MAX_TEXT } from '../cli/command'
import { assertPublicUrl, type ResolveHost } from '../cli/public-url'
import { requireRunId } from '../cli/runs'
import { requireEnqueueInput, requireItemId } from '../queue/queue'
import type { AgentId } from '@shared/runner-types'
import { AuditLog, type Known } from './audit'
import type { DeviceRecord, DeviceStore } from './devices'
import { projectJobsPage, projectQueue, projectRun, projectRunPage, projectRunsPage, projectStatus } from './project'
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
  queue: {
    state(): Promise<QueueState>
    setPaused(paused: boolean): Promise<QueueState>
    cancel(itemId: string): Promise<QueueState>
    retry(itemId: string): Promise<QueueState>
    /** Takes what `requireEnqueueInput` returned, exactly like `queue/ipc.ts`. */
    enqueue(input: ReturnType<typeof requireEnqueueInput>): Promise<EnqueueResult>
    /** The queue holds a reply for one of its waiting runs; `null` for any other run. */
    reply(runId: string, text: string): Promise<RunSummary | 'held' | null>
  }
  runs: {
    list(): Promise<RunSummary[]>
    get(runId: string): Promise<{ run: RunSummary; items: TranscriptItem[] }>
    /** Sends a reply to a run the queue does not manage (the Tailor page's path). */
    reply(runId: string, text: string): Promise<RunSummary>
    stop(runId: string): Promise<RunSummary>
    finish(runId: string): Promise<RunSummary>
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

const RATE = {
  /** `queue.enqueue` / `pipeline.start`: once per 10 s per device. */
  costlyMs: 10_000,
  /** `run.reply` / `review.rerun`: once per 2 s per run. */
  replyMs: 2_000,
  /** Reads: 30 per minute per device. */
  readsPerMinute: 30
} as const

/** Commands that touch the review queue or the pipeline (#31): not on this desktop yet. */
const NOT_YET: readonly RemoteCommandName[] = ['pipeline.start', 'pipeline.pause', 'pipeline.resume', 'pipeline.stop', 'review.list', 'review.get', 'review.approve', 'review.rerun', 'review.discard']

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
        for (const d of this.devices.list()) this.devices.raiseLastSeq(d.id, log.lastSeqOf(d.id))
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

  private async handleNow(given: DeviceRecord, envelope: Envelope): Promise<GatewayReply> {
    const id = envelope.id ?? envelope.re ?? 'unknown'
    const ack = id
    const at = new Date(this.now()).toISOString()
    let seq: number | undefined
    let name = typeof envelope.name === 'string' ? envelope.name.slice(0, 64) : 'unknown'
    let audit: AuditLog | null = null
    try {
      if (envelope.kind !== 'cmd' || envelope.id === undefined) throw new ProtocolError('invalid', 'Not a command.')
      requireFresh(envelope, this.now())
      const workspace = await this.services.workspace()
      audit = await this.auditFor(workspace.path)
      // The store's record, read after the log raised `lastSeq`; the caller's copy may predate that.
      const device = this.devices.get(given.id) ?? given
      if (device.needsRepair) throw new ProtocolError('denied', 'This phone must be paired again.')
      // A redelivery carries a seq the log already accepted: answer from the log, never as a replay.
      const known = audit.lookup(envelope.id)
      if (known && !(known.state === 'finished' && known.read)) return this.answerKnown(known, envelope, ack)
      try {
        seq = requireNextSeq(envelope.seq, device.lastSeq)
      } catch (err) {
        if (err instanceof ProtocolError && err.code === 'denied') await this.devices.markNeedsRepair(device.id)
        throw err
      }
      // Not checkpointed yet: the audit entry is the commit. A crash before it persists nothing, so
      // the relay's redelivery runs the command exactly once (ADR "Commit order on the desktop").
      requireWorkspace(envelope, workspace.id)
      const command = requireCommandEnvelope(envelope)
      name = command.name
      if ((NOT_YET as readonly string[]).includes(command.name)) {
        throw new ProtocolError('unsupported', 'Pipelines and reviews are not available on this Mac yet. Update Huntgry.')
      }
      this.checkTtl(envelope, command.name)
      this.checkRate(device.id, command)

      if (isReadCommand(command.name)) {
        const body = await this.execute(device, command, workspace)
        await audit.finish({ id: envelope.id, deviceId: device.id, seq, name: command.name, ok: true, read: true, ts: at })
        await this.devices.accept(device.id, seq, at)
        return { result: { kind: 'result', re: envelope.id, ok: true, body, ttl: envelope.ttl }, ack }
      }

      this.services.crashAt?.('before-start', command.name)
      await audit.start({ id: envelope.id, deviceId: device.id, seq, name: command.name, ts: at })
      await this.devices.accept(device.id, seq, at)
      this.services.crashAt?.('after-start', command.name)
      let body: unknown
      try {
        body = await this.execute(device, command, workspace)
      } catch (err) {
        const error = errorOf(err)
        console.error(`[remote] ${command.name} from ${device.name} failed:`, err)
        await audit.finish({ id: envelope.id, deviceId: device.id, seq, name: command.name, ok: false, error })
        return { result: { kind: 'result', re: envelope.id, ok: false, error, body: null, ttl: envelope.ttl }, ack }
      }
      this.services.crashAt?.('after-execute', command.name)
      await audit.finish({ id: envelope.id, deviceId: device.id, seq, name: command.name, ok: true, result: body })
      this.services.crashAt?.('after-finish', command.name)
      return { result: { kind: 'result', re: envelope.id, ok: true, body, ttl: envelope.ttl }, ack }
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err
      const error = errorOf(err)
      if (!(err instanceof ProtocolError)) console.error(`[remote] ${name} from ${given.name} failed:`, err)
      // Rejected frames are audited too (device, name, outcome); without a seq when it was never accepted.
      const entry = { id, deviceId: given.id, name, ok: false as const, error, ts: at }
      await audit?.finish(seq === undefined ? entry : { ...entry, seq }).catch((e) => console.error('[remote] audit write failed:', e))
      if (seq !== undefined) await this.devices.accept(given.id, seq, at).catch(() => undefined)
      return { result: { kind: 'result', re: id, ok: false, error, body: null, ttl: envelope.ttl }, ack }
    }
  }

  /** A frame that failed before it was an envelope (bad session, malformed): audited with its ref, never executed. */
  async recordRejected(device: DeviceRecord, ref: string, error: EnvelopeError): Promise<void> {
    try {
      const audit = await this.auditFor((await this.services.workspace()).path)
      await audit.finish({ id: ref, deviceId: device.id, name: 'unknown', ok: false, error, ts: new Date(this.now()).toISOString() })
    } catch (e) {
      console.error('[remote] audit write failed:', e)
    }
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
    const s = this.services
    switch (command.name) {
      case 'status.get':
        return projectStatus({ desktopName: s.desktopName, appVersion: s.appVersion, workspace, queue: await s.queue.state(), agents: await s.agents() })
      case 'queue.get':
        return projectQueue(await s.queue.state())
      case 'queue.setPaused':
        return projectQueue(await s.queue.setPaused(command.args.paused))
      case 'queue.cancel':
        return projectQueue(await s.queue.cancel(requireItemId(command.args.itemId)))
      case 'queue.retry':
        return projectQueue(await s.queue.retry(requireItemId(command.args.itemId)))
      case 'queue.enqueue': {
        // The package guard bounded jobIds, notes (≤ LIMITS.textBytes) and the enums; the queue's own validator runs too.
        if (command.args.options.notes !== undefined && command.args.options.notes.length > MAX_TEXT) throw new ProtocolError('invalid', 'The notes are too long.')
        const input = requireEnqueueInput(command.args, await s.defaultAgent())
        const result = await s.queue.enqueue(input)
        return { added: result.added, skipped: result.skipped.map((x) => ({ jobId: x.jobId, reason: x.reason.slice(0, LIMITS.shortStringChars) })), queue: projectQueue(result.state) }
      }
      case 'jobs.list':
        return projectJobsPage(await s.jobs.list(workspace.path), command.args.cursor, command.args.filter)
      case 'jobs.addUrl': {
        // The shape check happened in the package guard; this is the desktop's DNS-resolving public-host check.
        const target = await assertPublicUrl(command.args.url, s.resolveHost)
        const job = await s.jobs.addUrl(workspace.path, target.url.href)
        return projectJobsPage([job]).items[0]
      }
      case 'runs.list':
        return projectRunsPage(await s.runs.list(), command.args.cursor)
      case 'run.get': {
        const runId = requireRunId(command.args.runId)
        const { run, items } = await s.runs.get(runId)
        return projectRunPage(run, s.transcripts() ? items : [], command.args.sinceSeq ?? 0)
      }
      case 'run.reply': {
        const runId = requireRunId(command.args.runId)
        const text = command.args.text
        // The same rule as RUNNER_CHANNELS.reply: non-empty, at most MAX_TEXT, the queue first.
        if (!text.trim() || text.length > MAX_TEXT) throw new ProtocolError('invalid', 'Type a reply first.')
        const viaQueue = await s.queue.reply(runId, text)
        // Held by the queue until a slot is free (like a desktop reply): the run is unchanged for now.
        if (viaQueue === 'held') return projectRun((await s.runs.get(runId)).run)
        return projectRun(viaQueue ?? (await s.runs.reply(runId, text)))
      }
      case 'run.stop':
        return projectRun(await s.runs.stop(requireRunId(command.args.runId)))
      case 'run.finish':
        return projectRun(await s.runs.finish(requireRunId(command.args.runId)))
      case 'file.get':
        return this.fileChunk(workspace.path, command.args)
      case 'device.setNotifications':
        await this.devices.update(device.id, { categories: command.args.categories })
        return { categories: command.args.categories }
      case 'pipeline.start':
      case 'pipeline.pause':
      case 'pipeline.resume':
      case 'pipeline.stop':
      case 'review.list':
      case 'review.get':
      case 'review.approve':
      case 'review.rerun':
      case 'review.discard':
        throw new ProtocolError('unsupported', 'Pipelines and reviews are not available on this Mac yet. Update Huntgry.')
    }
  }

  /** One `LIMITS.fileChunkBytes` piece of an application file, with the whole file's SHA-256 on every chunk. */
  private async fileChunk(workspace: string, args: { applicationId: string; file: string; chunk: number }): Promise<FileChunk> {
    const path = await this.services.files.resolve(workspace, args.applicationId, args.file)
    const data = await readFile(path)
    const size = LIMITS.fileChunkBytes
    const of = Math.max(1, Math.ceil(data.length / size))
    if (args.chunk >= of) throw new ProtocolError('invalid', `This file has ${of} chunks.`)
    const piece = data.subarray(args.chunk * size, (args.chunk + 1) * size)
    return requireFileChunk({
      applicationId: args.applicationId,
      file: args.file,
      chunk: args.chunk,
      of,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      data: toBase64(new Uint8Array(piece))
    })
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
