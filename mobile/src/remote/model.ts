/**
 * The app's state: what the screens render, fed by the relay client (results, events,
 * notices) and changed by the owner's actions (commands). Plain TypeScript with a
 * `subscribe` / `getSnapshot` pair for `useSyncExternalStore`, so it is unit-tested in Node.
 *
 * Persistence is the vault's: keys, counters, the pairing and the last `StatusSummary`. The
 * queue, runs and transcripts here are memory only and are gone with the app.
 */

import {
  NOTIFICATION_CATEGORIES,
  ProtocolError,
  requireFileChunk,
  requireHelloBody,
  requireJobsPage,
  requirePipelineState,
  requireQueueState,
  requireRecord,
  requireRemoteJob,
  requireRemoteRun,
  requireReviewDetail,
  requireReviewList,
  requireRunPage,
  requireStatusSummary,
  requireEvent,
  type Envelope,
  type EnvelopeError,
  type FileChunk,
  type NotificationCategory,
  type PipelineStartInput,
  type PipelineState,
  type PipelineSummary,
  type RelayNotice,
  type RemoteFile,
  type RemoteJob,
  type RemoteQueueState,
  type RemoteRun,
  type RemoteTranscriptItem,
  type ReviewDetail,
  type ReviewItem,
  type StatusSummary
} from '@huntgry/remote-protocol'
import { commandLabel, commands, NoWorkspaceError, type Command, type DeliveryState } from './commands'
import { FileDownload, FileError, fileKey } from './files'
import { REVIEW_COPY, approvalIds, requiredPreviews } from './review'
import { PairingFlow, PairingError, type PairingStep } from './pairing'
import { systemClock, type Clock, type SocketFactory } from './platform'
import { RelayClient, StorageError, type ConnectionState, type FatalReason, type PushTokenState, type SentCommand } from './relay'
import type { Pairing, Vault } from './vault'

export interface RunView {
  run: RemoteRun | null
  items: RemoteTranscriptItem[]
  /** All pages loaded (no `nextSeq`). */
  complete: boolean
  loading: boolean
  error?: string
}

export interface CommandView {
  id: string
  name: Command['name']
  label: string
  state: DeliveryState
  error?: EnvelopeError
  at: number
  /** The run it is about (reply / finish / stop). */
  runId?: string
  itemId?: string
}

/** `jobs.list` pages loaded so far for one filter (#40). */
export interface JobsView {
  items: RemoteJob[]
  filter: string
  nextCursor?: string
  loading: boolean
  error?: string
}

/** `review.list` (#42). */
export interface ReviewsView {
  items: ReviewItem[]
  more: number
  loading: boolean
  error?: string
}

/** One result's `ReviewDetail` as last served, and what happened to the last decision. */
export interface ReviewView {
  detail: ReviewDetail | null
  loading: boolean
  error?: string
  /** Why the detail was reloaded (`stale`, `denied`, a change on the Mac). */
  notice?: string
  deciding?: 'approve' | 'rerun' | 'discard'
}

/** One application file (#40), in memory only. `data` is set once reassembled and hash-checked. */
export interface FileView {
  applicationId: string
  file: RemoteFile
  state: 'waiting' | 'loading' | 'ready' | 'failed'
  received: number
  of: number
  bytes: number
  /** The SHA-256 a review listed for this file, when it was fetched for one. */
  expected?: string
  /** The verified SHA-256 of `data`. */
  sha256?: string
  data?: Uint8Array
  error?: string
}

export interface Presence {
  online: boolean
  since: string
  queued: number
}

export interface Toast {
  id: number
  tone: 'error' | 'info'
  text: string
}

export interface RemoteSnapshot {
  phase: 'loading' | 'unpaired' | 'paired'
  /** Why the app is back on the Pair screen ("Pair again"). */
  pairAgain: { reason: FatalReason; message: string } | null
  pairingStep: PairingStep
  pairing: Pairing | null
  connection: ConnectionState
  presence: Presence | null
  status: StatusSummary | null
  statusAt: string | null
  workspace: { id: string; name: string } | null
  queue: RemoteQueueState | null
  pipeline: PipelineState | null
  lastPipeline: PipelineSummary | null
  runs: Record<string, RunView>
  /** The last `RemoteRun` seen for each run (run.changed, run.get, replies): durations, tokens, cost for queue cards. */
  runInfo: Record<string, RemoteRun>
  jobs: JobsView | null
  reviews: ReviewsView | null
  /** By application id. */
  review: Record<string, ReviewView>
  /** By `fileKey(applicationId, file)`. */
  files: Record<string, FileView>
  commands: CommandView[]
  toast: Toast | null
  demo: boolean
}

export interface ModelDeps {
  vault: Vault
  socket: SocketFactory
  appVersion: string
  /** The phone's own name for `pair.hello` (expo-device). */
  deviceName: string
  clock?: Clock
  random?: () => number
}

/** Pages fetched in a row when a run opens; more come with "Load more" (`loadMoreRun`). */
const AUTO_PAGES = 12
const COMMAND_HISTORY = 20
/** Files kept in memory; the oldest go first (previews are fetched again when needed). */
const FILES_KEPT = 24
/**
 * The desktop answers at most 30 reads a minute per phone (`RATE.readsPerMinute` in the gateway),
 * and every `file.get` chunk is one read. Chunks are paced to this many a minute, which leaves
 * room for the lists and details the owner opens meanwhile; a 1 MB PDF takes about two minutes.
 */
const CHUNK_READS_PER_MINUTE = 24
/** A chunk the desktop refused as `rate-limited` is asked for again after this, progress kept. */
const CHUNK_RETRY_MS = 10_000
/** Refusals in a row before the download gives up (about two minutes of a busy desktop). */
const CHUNK_RETRIES = 12

export const INITIAL_SNAPSHOT: RemoteSnapshot = {
  phase: 'loading',
  pairAgain: null,
  pairingStep: { step: 'idle' },
  pairing: null,
  connection: 'stopped',
  presence: null,
  status: null,
  statusAt: null,
  workspace: null,
  queue: null,
  pipeline: null,
  lastPipeline: null,
  runs: {},
  runInfo: {},
  jobs: null,
  reviews: null,
  review: {},
  files: {},
  commands: [],
  toast: null,
  demo: false
}

export class RemoteModel {
  protected snap: RemoteSnapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private client: RelayClient | null = null
  private flow: PairingFlow | null = null
  /** Command id → what it was, for results that arrive after `sent` was forgotten. */
  private readonly requests = new Map<string, Command>()
  private readonly runPages = new Map<string, number>()
  /** File downloads: one at a time, in the order asked (the relay's frame budget is shared). */
  private readonly downloads = new Map<string, FileDownload>()
  private readonly downloadQueue: string[] = []
  private activeDownload: string | null = null
  /** Which download each `file.get` was sent for: answers to a superseded one are ignored. */
  private readonly chunkOwner = new WeakMap<Command, FileDownload>()
  /** When recent `file.get`s were sent (the last minute), for pacing under the desktop's read limit. */
  private chunkStamps: number[] = []
  private chunkTimer: unknown = null
  private chunkRetries = 0
  /** The result the owner has open: refreshed when the Mac's application folders change. */
  private openReviewId: string | null = null
  /** Results whose folder changed while their `review.get` was in flight: fetched again once it lands. */
  private reviewRefresh = new Set<string>()
  private toastSeq = 0
  /** The Expo push token for the relay (#39); `undefined` until the push module has an answer. */
  private pushToken: PushTokenState = undefined
  /** False from an unpair (or "pair again") until the next pairing connects: a token fetched for the old pairing is dropped. */
  private pushOpen = true
  private sleepTimer: unknown = null
  protected readonly clock: Clock

  constructor(protected readonly deps: ModelDeps) {
    this.clock = deps.clock ?? systemClock
  }

  // ── store ────────────────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): RemoteSnapshot => this.snap

  protected set(patch: Partial<RemoteSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    for (const l of this.listeners) l()
  }

  private setRun(runId: string, patch: Partial<RunView>): void {
    const prev = this.snap.runs[runId] ?? { run: null, items: [], complete: false, loading: false }
    const runInfo = patch.run ? { ...this.snap.runInfo, [runId]: patch.run } : this.snap.runInfo
    this.set({ runs: { ...this.snap.runs, [runId]: { ...prev, ...patch } }, runInfo })
  }

  toast(text: string, tone: Toast['tone'] = 'error'): void {
    this.set({ toast: { id: ++this.toastSeq, tone, text } })
  }

  dismissToast(): void {
    this.set({ toast: null })
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const pairing = await this.deps.vault.loadPairing()
    if (!pairing) {
      this.set({ phase: 'unpaired' })
      return
    }
    const stored = await this.deps.vault.loadStatus()
    this.set({ phase: 'paired', pairing, status: stored?.status ?? null, statusAt: stored?.at ?? null })
    this.connect(pairing)
  }

  private connect(pairing: Pairing): void {
    this.client?.stop()
    const client = new RelayClient({
      pairing,
      vault: this.deps.vault,
      socket: this.deps.socket,
      clock: this.clock,
      random: this.deps.random,
      appVersion: this.deps.appVersion,
      workspaceId: () => this.workspaceId(),
      events: {
        onState: (connection) => this.set({ connection }),
        onNotice: (notice) => this.onNotice(notice),
        onDelivery: (id, state, error) => this.onDelivery(id, state, error),
        onEnvelope: (env, sent) => this.onEnvelope(env, sent),
        onFatal: (reason, message) => this.onFatal(reason, message)
      }
    })
    this.client = client
    this.pushOpen = true
    client.setPushToken(this.pushToken)
    client.start()
  }

  /** App foregrounded / network back. */
  wake(): void {
    if (this.sleepTimer !== null) this.clock.clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    this.client?.wake()
  }

  /**
   * App in the background: after a short grace (a reply just sent still leaves), the socket
   * closes so the relay pushes instead of writing to a suspended app. `wake()` reconnects.
   */
  background(graceMs = 2_000): void {
    if (this.sleepTimer !== null) this.clock.clearTimeout(this.sleepTimer)
    this.sleepTimer = this.clock.setTimeout(() => {
      this.sleepTimer = null
      this.client?.sleep()
    }, graceMs)
  }

  /** Stops the socket (tests, sign-out). */
  stop(): void {
    this.client?.stop()
    this.client = null
  }

  workspaceId(): string | null {
    return this.snap.status?.desktop.workspaceId ?? this.snap.workspace?.id ?? null
  }

  // ── pairing ──────────────────────────────────────────────────────────────────────────

  /** Scanned, pasted or deep-linked `huntgry://pair?…`. Resolves when the flow ends either way. */
  async pair(qrText: string): Promise<void> {
    if (this.flow) return
    const flow = new PairingFlow({
      vault: this.deps.vault,
      socket: this.deps.socket,
      clock: this.clock,
      appVersion: this.deps.appVersion,
      deviceName: this.deps.deviceName,
      onStep: (pairingStep) => this.set({ pairingStep })
    })
    this.flow = flow
    try {
      const pairing = await flow.start(qrText)
      this.set({ ...INITIAL_SNAPSHOT, phase: 'paired', pairing, pairingStep: { step: 'idle' }, demo: this.snap.demo })
      this.connect(pairing)
      // ADR "Pairing", step 12: the desktop learns the phone's notification categories (all on by default).
      this.dispatch(commands.setNotifications(pairing.categories), { quiet: true })
    } catch (err) {
      if (!(err instanceof PairingError)) this.set({ pairingStep: { step: 'error', message: 'Pairing failed.' } })
    } finally {
      this.flow = null
    }
  }

  cancelPairing(): void {
    this.flow?.cancel()
    this.set({ pairingStep: { step: 'idle' } })
  }

  resetPairing(): void {
    if (!this.flow) this.set({ pairingStep: { step: 'idle' } })
  }

  /**
   * The Expo push token the relay should push to (#39), `null` to remove it (push turned off or
   * not allowed). Travels as the clear `{ pushToken }` frame after every authentication, never
   * to the desktop.
   */
  setPushToken(token: PushTokenState): void {
    if (!this.pushOpen) return
    this.pushToken = token
    this.client?.setPushToken(token)
  }

  /** Where the push choice is kept: with the pairing, so unpairing forgets it. */
  pushPrefs(): { load(): Promise<boolean | null>; save(enabled: boolean): Promise<void> } {
    return { load: () => this.deps.vault.loadPushEnabled(), save: (enabled) => this.deps.vault.savePushEnabled(enabled) }
  }

  /** The owner unpairs this phone (revoke it on the Mac too). The relay forgets the push token first. */
  async unpair(): Promise<void> {
    const client = this.client
    this.client = null
    this.pushToken = undefined
    this.pushOpen = false
    if (client) await client.farewell()
    await this.deps.vault.wipe()
    this.requests.clear()
    this.forgetDownloads()
    this.set({ ...INITIAL_SNAPSHOT, phase: 'unpaired', demo: this.snap.demo })
  }

  private async onFatal(reason: FatalReason, message: string): Promise<void> {
    this.client = null
    this.pushToken = undefined
    this.pushOpen = false
    // Pair again: every key and counter goes; the next pairing mints a new identity.
    await this.deps.vault.wipe()
    this.requests.clear()
    this.forgetDownloads()
    this.set({ ...INITIAL_SNAPSHOT, phase: 'unpaired', pairAgain: { reason, message }, demo: this.snap.demo })
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────

  /** Sends a command; failures to even queue it show as a toast. Returns the id, or null. */
  protected dispatch(command: Command, meta: { runId?: string; itemId?: string; quiet?: boolean } = {}): string | null {
    if (!this.client) {
      if (!meta.quiet) this.toast('Not connected to your Mac yet.')
      return null
    }
    let id: string
    try {
      id = this.client.send(command)
    } catch (err) {
      if (!meta.quiet) this.toast(err instanceof NoWorkspaceError ? err.message : 'Could not send that.')
      return null
    }
    this.track(id, command, meta)
    return id
  }

  protected track(id: string, command: Command, meta: { runId?: string; itemId?: string; quiet?: boolean }): void {
    this.requests.set(id, command)
    if (this.requests.size > 200) this.requests.delete(this.requests.keys().next().value as string)
    if (meta.quiet) return
    const view: CommandView = {
      id,
      name: command.name,
      label: commandLabel(command, (runId) => this.snap.runs[runId]?.run?.title ?? this.runTitleFromQueue(runId)),
      state: 'sending',
      at: this.clock.now(),
      runId: meta.runId,
      itemId: meta.itemId
    }
    this.set({ commands: [view, ...this.snap.commands].slice(0, COMMAND_HISTORY) })
  }

  private runTitleFromQueue(runId: string): string | undefined {
    const title = this.snap.queue?.items.find((i) => i.runId === runId)?.title
    return title?.split(' · ')[0]
  }

  private onDelivery(id: string, state: DeliveryState, error?: EnvelopeError): void {
    // Expired or too large at the relay, or never sealed: no result will come for it.
    const lost = state === 'expired' || state === 'too-large' || (state === 'failed' && this.requests.has(id))
    const command = lost ? this.requests.get(id) : undefined
    if (command) {
      this.requests.delete(id)
      this.settleLost(command, error ?? { code: 'expired', message: state === 'too-large' ? 'That was too large to send.' : 'Expired before your Mac woke up.' })
    }
    if (!this.snap.commands.some((c) => c.id === id)) return
    this.set({ commands: this.snap.commands.map((c) => (c.id === id ? { ...c, state, error } : c)) })
    if (state === 'expired') this.toast('Expired before your Mac woke up.', 'info')
    if (state === 'too-large') this.toast('That was too large to send.')
  }

  refreshStatus(): void {
    this.dispatch(commands.status(), { quiet: true })
  }

  refreshQueue(): void {
    if (this.workspaceId()) this.dispatch(commands.queue(), { quiet: true })
  }

  setQueuePaused(paused: boolean): void {
    this.dispatch(commands.setQueuePaused(paused))
  }

  cancelItem(itemId: string): void {
    this.dispatch(commands.cancel(itemId), { itemId })
  }

  retryItem(itemId: string): void {
    this.dispatch(commands.retry(itemId), { itemId })
  }

  pipelinePause(): void {
    this.dispatch(commands.pipelinePause())
  }

  pipelineResume(): void {
    this.dispatch(commands.pipelineResume())
  }

  pipelineStop(): void {
    this.dispatch(commands.pipelineStop())
  }

  /** Throws `ProtocolError('invalid')` for an empty or over-32-KiB reply (the screen caps it first). */
  reply(runId: string, text: string): boolean {
    return this.dispatch(commands.reply(runId, text), { runId }) !== null
  }

  finishRun(runId: string): void {
    this.dispatch(commands.finish(runId), { runId })
  }

  stopRun(runId: string): void {
    this.dispatch(commands.stop(runId), { runId })
  }

  // ── pipeline (#41) ───────────────────────────────────────────────────────────────────

  /** `pipeline.start` with the start sheet's input (already through `pipelineStartInput`). */
  startPipeline(input: PipelineStartInput): boolean {
    try {
      return this.dispatch(commands.pipelineStart(input)) !== null
    } catch (err) {
      this.toast(err instanceof ProtocolError ? err.message : 'That pipeline cannot be started.')
      return false
    }
  }

  /** Saved jobs to the attended queue (`queue.enqueue`) with "Run unattended"'s document options. */
  enqueueJobs(jobIds: readonly string[]): boolean {
    try {
      return this.dispatch(commands.enqueue({ jobIds: [...jobIds], options: { coverLetter: true, dateStyle: 'right' } })) !== null
    } catch (err) {
      this.toast(err instanceof ProtocolError ? err.message : 'Those jobs cannot be queued.')
      return false
    }
  }

  // ── jobs (#40) ───────────────────────────────────────────────────────────────────────

  /** The first page for `filter` (search on title, company, location), or the next page with `more`. */
  loadJobs(filter = this.snap.jobs?.filter ?? '', more = false): void {
    const f = filter.trim().slice(0, 128)
    const prev = this.snap.jobs
    const cursor = more && prev && prev.filter === f ? prev.nextCursor : undefined
    if (more && !cursor) return
    if (prev?.loading && prev.filter === f) return
    this.set({ jobs: { items: prev && prev.filter === f ? prev.items : [], filter: f, nextCursor: prev?.filter === f ? prev.nextCursor : undefined, loading: true } })
    if (this.dispatch(commands.jobs(f || undefined, cursor), { quiet: true }) === null) this.set({ jobs: { ...this.snap.jobs!, loading: false, error: 'Not connected to your Mac yet.' } })
  }

  /** `jobs.addUrl`: the package refuses non-http(s), local and private hosts before anything is sent. */
  addJobUrl(url: string): boolean {
    let command: Command
    try {
      command = commands.addJobUrl(url)
    } catch (err) {
      this.toast(err instanceof ProtocolError ? friendlyUrlError(err.message) : 'That is not a job link.')
      return false
    }
    return this.dispatch(command) !== null
  }

  // ── review (#42) ─────────────────────────────────────────────────────────────────────

  loadReviews(): void {
    if (this.snap.reviews?.loading) return
    this.set({ reviews: { items: this.snap.reviews?.items ?? [], more: this.snap.reviews?.more ?? 0, loading: true } })
    if (this.dispatch(commands.reviews(), { quiet: true }) === null) this.set({ reviews: { ...this.snap.reviews!, loading: false, error: 'Not connected to your Mac yet.' } })
  }

  private setReview(applicationId: string, patch: Partial<ReviewView>): void {
    const prev = this.snap.review[applicationId] ?? { detail: null, loading: false }
    this.set({ review: { ...this.snap.review, [applicationId]: { ...prev, ...patch } } })
  }

  /** `review.get`: the detail is what a decision is bound to (the gateway records it as served). */
  openReview(applicationId: string, notice?: string): void {
    this.openReviewId = applicationId
    const view = this.snap.review[applicationId]
    if (view?.loading) {
      if (notice) this.setReview(applicationId, { notice })
      return
    }
    this.setReview(applicationId, { loading: true, error: undefined, ...(notice ? { notice } : {}) })
    if (this.dispatch(commands.review(applicationId), { quiet: true }) === null) this.setReview(applicationId, { loading: false, error: 'Not connected to your Mac yet.' })
  }

  /** The Files screen of a result already loaded: refreshed on `applications.changed` like the detail. */
  watchReview(applicationId: string): void {
    if (!this.snap.review[applicationId]?.detail) {
      this.openReview(applicationId)
      return
    }
    this.openReviewId = applicationId
  }

  closeReview(applicationId: string): void {
    if (this.openReviewId === applicationId) this.openReviewId = null
  }

  dismissReviewNotice(applicationId: string): void {
    if (this.snap.review[applicationId]?.notice) this.setReview(applicationId, { notice: undefined })
  }

  /** Approve with the ticked reframings: the served revision and only ids that detail listed. */
  approve(applicationId: string, ticked: Iterable<string>): boolean {
    const d = this.snap.review[applicationId]?.detail
    if (!d) return false
    return this.decide(applicationId, 'approve', () => commands.approve(applicationId, d.revision, approvalIds(d, ticked)))
  }

  /** Re-run with answers (≤ 32 KiB): the same run, the same session, through the desktop's reply path. */
  rerun(applicationId: string, answers: string): boolean {
    const d = this.snap.review[applicationId]?.detail
    if (!d) return false
    return this.decide(applicationId, 'rerun', () => commands.rerun(d.runId, d.revision, answers))
  }

  /** Discard: the desktop archives the result and keeps every file. */
  discard(applicationId: string): boolean {
    const d = this.snap.review[applicationId]?.detail
    if (!d) return false
    return this.decide(applicationId, 'discard', () => commands.discard(applicationId, d.revision))
  }

  private decide(applicationId: string, kind: NonNullable<ReviewView['deciding']>, build: () => Command): boolean {
    if (this.snap.review[applicationId]?.deciding) return false
    let command: Command
    try {
      command = build()
    } catch (err) {
      this.toast(err instanceof ProtocolError ? err.message : 'That cannot be sent.')
      return false
    }
    if (this.dispatch(command) === null) return false
    this.setReview(applicationId, { deciding: kind, notice: undefined })
    return true
  }

  // ── files (#40) ──────────────────────────────────────────────────────────────────────

  /**
   * Fetches an application file chunk by chunk (`file.get`), reassembles it and keeps it in
   * memory once its SHA-256 matches (and equals `expected`, the hash a review listed).
   */
  fetchFile(applicationId: string, file: RemoteFile, expected?: string): void {
    const key = fileKey(applicationId, file)
    const view = this.snap.files[key]
    const inFlight = view !== undefined && (view.state === 'waiting' || view.state === 'loading') && this.downloads.has(key)
    // In flight for the same hash: nothing to do. For another hash (a refreshed review), it is replaced.
    if (inFlight && (expected === undefined || view.expected === expected)) return
    if (view?.state === 'ready' && (expected === undefined || view.sha256 === expected)) return
    const dl = new FileDownload(applicationId, file, expected)
    this.downloads.set(key, dl)
    this.setFile(key, { applicationId, file, state: 'waiting', received: 0, of: 0, bytes: 0, expected })
    if (this.activeDownload === key) {
      // The old download's outstanding chunk is ignored when it arrives (`chunkOwner`).
      this.restartChunks()
      this.requestChunk(key, dl)
      return
    }
    if (!this.downloadQueue.includes(key)) this.downloadQueue.push(key)
    this.pumpDownloads()
  }

  /** The verified SHA-256 of a file the phone holds, or null. */
  verifiedSha(applicationId: string, file: RemoteFile): string | null {
    const view = this.snap.files[fileKey(applicationId, file)]
    return view?.state === 'ready' ? (view.sha256 ?? null) : null
  }

  private setFile(key: string, view: FileView): void {
    const files = { ...this.snap.files, [key]: view }
    // The open result's page-1 previews stay: Approve waits on them and nothing would fetch them again.
    const open = this.openReviewId
    const detail = open ? this.snap.review[open]?.detail : null
    const kept = new Set(open && detail ? requiredPreviews(detail).map((f) => fileKey(open, f)) : [])
    kept.add(key)
    const ready = Object.keys(files).filter((k) => files[k].state === 'ready')
    const evictable = ready.filter((k) => !kept.has(k))
    // Memory only, and bounded: the oldest verified files go first.
    for (const k of evictable.slice(0, Math.max(0, ready.length - FILES_KEPT))) delete files[k]
    this.set({ files })
  }

  private pumpDownloads(): void {
    while (this.activeDownload === null && this.downloadQueue.length > 0) {
      const key = this.downloadQueue.shift()!
      const dl = this.downloads.get(key)
      if (!dl) continue
      this.activeDownload = key
      this.requestChunk(key, dl)
    }
  }

  private requestChunk(key: string, dl: FileDownload): void {
    const now = this.clock.now()
    this.chunkStamps = this.chunkStamps.filter((t) => now - t < 60_000)
    if (this.chunkStamps.length >= CHUNK_READS_PER_MINUTE) {
      // Over the pace: ask when the oldest request of the minute has aged out.
      this.chunkLater(key, dl, this.chunkStamps[0] + 60_000 - now)
      return
    }
    const command = commands.file(dl.applicationId, dl.file, dl.next)
    this.chunkOwner.set(command, dl)
    this.chunkStamps.push(now)
    if (this.dispatch(command, { quiet: true }) === null) this.failDownload(key, 'Not connected to your Mac yet.')
  }

  private chunkLater(key: string, dl: FileDownload, ms: number): void {
    this.restartChunks()
    this.chunkTimer = this.clock.setTimeout(() => {
      this.chunkTimer = null
      if (this.activeDownload === key && this.downloads.get(key) === dl) this.requestChunk(key, dl)
    }, Math.max(0, ms))
  }

  /** Drops a pending paced or retried request (the download it was for ended or was replaced). */
  private restartChunks(): void {
    if (this.chunkTimer !== null) this.clock.clearTimeout(this.chunkTimer)
    this.chunkTimer = null
    this.chunkRetries = 0
  }

  /**
   * A `file.get` that got no chunk. One sent for a download since replaced is ignored; a
   * `rate-limited` refusal asks for the same chunk again later and keeps what has arrived.
   */
  private chunkFailed(command: Extract<Command, { name: 'file.get' }>, error: EnvelopeError | undefined, message: string): void {
    const key = fileKey(command.args.applicationId, command.args.file)
    const dl = this.downloads.get(key)
    const owner = this.chunkOwner.get(command)
    if (!dl || (owner !== undefined && owner !== dl)) return
    if (error?.code === 'rate-limited' && this.activeDownload === key && this.chunkRetries < CHUNK_RETRIES) {
      const retries = this.chunkRetries + 1
      this.chunkLater(key, dl, CHUNK_RETRY_MS)
      this.chunkRetries = retries
      return
    }
    this.failDownload(key, message)
  }

  private failDownload(key: string, error: string): void {
    const view = this.snap.files[key]
    if (this.activeDownload === key) this.restartChunks()
    this.downloads.delete(key)
    if (view) this.setFile(key, { ...view, state: 'failed', data: undefined, sha256: undefined, error })
    if (this.activeDownload === key) this.activeDownload = null
    this.pumpDownloads()
  }

  private onChunk(chunk: FileChunk, owner?: FileDownload): void {
    const key = fileKey(chunk.applicationId, chunk.file)
    const dl = this.downloads.get(key)
    // A chunk for a download that was cancelled or replaced, or a late duplicate.
    if (!dl || this.activeDownload !== key || chunk.chunk !== dl.next || (owner !== undefined && owner !== dl)) return
    this.chunkRetries = 0
    const view = this.snap.files[key]
    if (!view) return
    let outcome: ReturnType<FileDownload['add']>
    try {
      outcome = dl.add(chunk)
    } catch (err) {
      this.failDownload(key, err instanceof FileError ? err.message : 'This file could not be loaded.')
      return
    }
    const progress = dl.progress
    if (!outcome.done) {
      this.setFile(key, { ...view, state: 'loading', received: progress.received, of: progress.of, bytes: progress.bytes })
      this.requestChunk(key, dl)
      return
    }
    this.downloads.delete(key)
    this.activeDownload = null
    this.restartChunks()
    this.setFile(key, { ...view, state: 'ready', received: progress.of, of: progress.of, bytes: progress.bytes, sha256: dl.sha256 ?? undefined, data: outcome.data, error: undefined })
    this.pumpDownloads()
  }

  /** Drops every file held in memory (unpair, pair again). */
  private forgetDownloads(): void {
    this.downloads.clear()
    this.downloadQueue.length = 0
    this.activeDownload = null
    this.restartChunks()
    this.openReviewId = null
    this.reviewRefresh.clear()
  }

  /** A command the relay dropped (expired, too large) or the phone could not send: no result will come. */
  protected settleLost(command: Command, error: EnvelopeError): void {
    switch (command.name) {
      case 'file.get':
        this.chunkFailed(command, error, error.message)
        return
      case 'jobs.list':
      case 'review.list':
      case 'review.get':
      case 'run.get':
        this.onFailure(command, error)
        return
      case 'review.approve':
      case 'review.discard':
        this.setReview(command.args.applicationId, { deciding: undefined })
        return
      case 'review.rerun':
        for (const [id, v] of Object.entries(this.snap.review)) if (v.detail?.runId === command.args.runId && v.deciding) this.setReview(id, { deciding: undefined })
        return
      default:
        return
    }
  }

  async setNotifications(categories: readonly NotificationCategory[]): Promise<void> {
    const pairing = this.snap.pairing
    if (!pairing) return
    const next = { ...pairing, categories: NOTIFICATION_CATEGORIES.filter((c) => categories.includes(c)) }
    await this.deps.vault.updatePairing(next)
    this.set({ pairing: next })
    this.dispatch(commands.setNotifications(next.categories), { quiet: true })
  }

  /** Renames this phone; the desktop picks the name up from the next `hello`. */
  async setDeviceName(name: string): Promise<void> {
    const pairing = this.snap.pairing
    const trimmed = name.trim().slice(0, 64)
    if (!pairing || !trimmed || trimmed === pairing.deviceName) return
    const next = { ...pairing, deviceName: trimmed }
    await this.deps.vault.updatePairing(next)
    this.client?.setPairing(next)
    this.set({ pairing: next })
  }

  /** Loads a run's transcript from the start, page by page (`run.get` with `sinceSeq`). */
  openRun(runId: string): void {
    const view = this.snap.runs[runId]
    if (view?.loading) return
    if (view && view.complete) {
      this.refreshRun(runId)
      return
    }
    this.setRun(runId, { loading: true, error: undefined })
    this.runPages.set(runId, 0)
    if (this.dispatch(commands.run(runId, view?.items.length || undefined), { quiet: true }) === null) this.setRun(runId, { loading: false })
  }

  /** The next pages of a transcript that stopped at the automatic page limit (or failed to load). */
  loadMoreRun(runId: string): void {
    const view = this.snap.runs[runId]
    if (!view || view.loading || view.complete) return
    this.openRun(runId)
  }

  /** New items since the last one (the last item is fetched again: a running tool may have finished). */
  refreshRun(runId: string): void {
    const view = this.snap.runs[runId]
    if (!view || view.loading || !view.complete) return
    this.setRun(runId, { loading: true })
    this.runPages.set(runId, 0)
    if (this.dispatch(commands.run(runId, Math.max(0, view.items.length - 1)), { quiet: true }) === null) this.setRun(runId, { loading: false })
  }

  /** The queue holds a reply for this run, or this phone's reply has not been answered yet. */
  replyHeld(runId: string): boolean {
    if (this.snap.queue?.items.some((i) => i.runId === runId && i.hasPendingReply)) return true
    return this.snap.commands.some((c) => c.name === 'run.reply' && c.runId === runId && (c.state === 'sending' || c.state === 'sent' || c.state === 'queued'))
  }

  // ── incoming ─────────────────────────────────────────────────────────────────────────

  private onNotice(notice: RelayNotice): void {
    if ('presence' in notice) this.set({ presence: { online: notice.presence === 'online', since: notice.since, queued: notice.queued } })
  }

  protected async onEnvelope(env: Envelope, sent: SentCommand | undefined): Promise<void> {
    switch (env.kind) {
      case 'hello': {
        const hello = requireHelloBody(env.body)
        this.set({ workspace: hello.workspace ?? null })
        // The desktop follows its hello with a `status` event; the queue needs asking.
        if (hello.workspace) this.dispatch(commands.queue(), { quiet: true })
        return
      }
      case 'event':
        await this.onEvent(env.name!, env.body)
        return
      case 'result': {
        const command = sent?.command ?? this.requests.get(env.re!)
        this.requests.delete(env.re!)
        if (!command) return
        if (!env.ok) {
          this.onFailure(command, env.error)
          return
        }
        await this.onResult(command, env.body)
        return
      }
      default:
        return // pong
    }
  }

  protected async onResult(command: Command, body: unknown): Promise<void> {
    switch (command.name) {
      case 'status.get':
        await this.applyStatus(requireStatusSummary(body))
        return
      case 'queue.get':
      case 'queue.setPaused':
      case 'queue.cancel':
      case 'queue.retry':
        this.set({ queue: requireQueueState(body) })
        return
      case 'run.get': {
        const page = requireRunPage(body)
        const runId = command.args.runId
        const view = this.snap.runs[runId] ?? { run: null, items: [], complete: false, loading: false }
        const items = mergeItems(view.items, command.args.sinceSeq ?? 0, page.items)
        const pages = (this.runPages.get(runId) ?? 0) + 1
        this.runPages.set(runId, pages)
        if (page.nextSeq !== undefined && pages < AUTO_PAGES) {
          this.setRun(runId, { run: page.run, items, complete: false, loading: true })
          if (this.dispatch(commands.run(runId, page.nextSeq), { quiet: true }) === null) this.setRun(runId, { loading: false })
        } else {
          this.setRun(runId, { run: page.run, items, complete: page.nextSeq === undefined, loading: false })
        }
        return
      }
      case 'run.reply':
      case 'run.finish':
      case 'run.stop': {
        const run = requireRemoteRun(body)
        this.setRun(run.id, { run })
        this.refreshRun(run.id)
        return
      }
      case 'queue.enqueue': {
        const r = requireRecord(body, 'queue.enqueue')
        this.set({ queue: requireQueueState(r.queue) })
        const added = typeof r.added === 'number' ? r.added : 0
        const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0
        this.toast(`Queued ${added} job${added === 1 ? '' : 's'}${skipped ? `; ${skipped} skipped (already queued or tailored)` : ''}.`, 'info')
        return
      }
      case 'pipeline.start':
      case 'pipeline.pause':
      case 'pipeline.resume':
      case 'pipeline.stop':
        // The desktop answers with the pipeline as its panel shows it now.
        this.set({ pipeline: requirePipelineState(body), ...(command.name === 'pipeline.start' ? { lastPipeline: null } : {}) })
        return
      case 'jobs.list': {
        const page = requireJobsPage(body)
        const filter = command.args.filter ?? ''
        const prev = this.snap.jobs
        // A page for a search the owner has since changed is dropped.
        if (prev && prev.filter !== filter) return
        const items = command.args.cursor && prev ? [...prev.items, ...page.items.filter((j) => !prev.items.some((p) => p.id === j.id))] : page.items
        this.set({ jobs: { items, filter, nextCursor: page.nextCursor, loading: false } })
        return
      }
      case 'jobs.addUrl': {
        const job = requireRemoteJob(body)
        const prev = this.snap.jobs
        if (prev) this.set({ jobs: { ...prev, items: [job, ...prev.items.filter((j) => j.id !== job.id)] } })
        this.toast(`Saved “${job.title}”${job.company ? ` at ${job.company}` : ''}.`, 'info')
        return
      }
      case 'review.list': {
        const list = requireReviewList(body)
        this.set({ reviews: { items: list.items, more: list.more ?? 0, loading: false } })
        return
      }
      case 'review.get': {
        const detail = requireReviewDetail(body)
        const prev = this.snap.review[command.args.applicationId]
        // A new revision the owner did not ask for (a rebuild on the Mac): say so.
        const changed = prev?.detail && prev.detail.revision !== detail.revision && !prev.notice
        this.applyDetail(command.args.applicationId, detail)
        if (changed) this.setReview(command.args.applicationId, { notice: REVIEW_COPY.changed })
        // The folder changed while this was on its way: it may predate that change.
        if (this.reviewRefresh.delete(command.args.applicationId) && this.openReviewId === command.args.applicationId && !this.snap.review[command.args.applicationId]?.deciding) {
          this.openReview(command.args.applicationId)
        }
        return
      }
      case 'review.approve':
      case 'review.discard':
      case 'review.rerun': {
        const detail = requireReviewDetail(body)
        // A refresh that landed first may already show a newer revision than the one decided on: keep it.
        const shown = this.snap.review[detail.applicationId]?.detail
        if (!shown || shown.revision === command.args.revision) this.applyDetail(detail.applicationId, detail)
        else this.setReview(detail.applicationId, { deciding: undefined })
        this.toast(command.name === 'review.approve' ? REVIEW_COPY.approved : command.name === 'review.discard' ? REVIEW_COPY.discarded : REVIEW_COPY.rerun, 'info')
        this.loadReviews()
        return
      }
      case 'file.get':
        this.onChunk(requireFileChunk(body), this.chunkOwner.get(command))
        return
      default:
        return
    }
  }

  /** A served detail: shown, and the previews Approve waits for are fetched against its hashes. */
  private applyDetail(applicationId: string, detail: ReviewDetail): void {
    this.setReview(applicationId, { detail, loading: false, deciding: undefined, error: undefined })
    for (const file of requiredPreviews(detail)) {
      const listed = detail.artifacts.find((a) => a.file === file)
      if (listed && listed.bytes > 0) this.fetchFile(applicationId, file, listed.sha256)
    }
    // Notes too long to travel inline come as a file.
    if (detail.reviewNotes === null) {
      const listed = detail.artifacts.find((a) => a.file === 'review-notes.md')
      this.fetchFile(applicationId, 'review-notes.md', listed?.sha256)
    }
  }

  protected onFailure(command: Command, error: EnvelopeError | undefined): void {
    const message = error?.message ?? 'Your Mac could not do that.'
    switch (command.name) {
      case 'run.get':
        this.setRun(command.args.runId, { loading: false, error: error?.message ?? 'Could not load this run.' })
        return
      case 'status.get':
      case 'queue.get':
        return
      case 'jobs.list':
        if (this.snap.jobs) this.set({ jobs: { ...this.snap.jobs, loading: false, error: message } })
        return
      case 'review.list':
        if (this.snap.reviews) this.set({ reviews: { ...this.snap.reviews, loading: false, error: message } })
        return
      case 'review.get':
        this.reviewRefresh.delete(command.args.applicationId)
        this.setReview(command.args.applicationId, { loading: false, error: message })
        return
      case 'file.get':
        this.chunkFailed(command, error, message)
        return
      case 'review.approve':
      case 'review.discard':
      case 'review.rerun':
        this.onDecisionFailure(command, error)
        return
      default:
        this.toast(message)
    }
  }

  /**
   * A refused decision. `stale`: the result changed on the Mac; `denied`: this phone was not
   * served that revision (the Mac restarted, or the phone re-paired). Neither ends the
   * pairing (the relay client keeps `review.*` out of "pair again"): the detail is fetched
   * again and the owner decides on what is shown now. Anything else is the desktop's message.
   */
  private onDecisionFailure(command: Extract<Command, { name: 'review.approve' | 'review.discard' | 'review.rerun' }>, error: EnvelopeError | undefined): void {
    const applicationId =
      command.name === 'review.rerun' ? Object.keys(this.snap.review).find((id) => this.snap.review[id].detail?.runId === command.args.runId) : command.args.applicationId
    if (!applicationId) {
      this.toast(error?.message ?? 'Your Mac could not do that.')
      return
    }
    this.setReview(applicationId, { deciding: undefined })
    if (error?.code === 'stale' || error?.code === 'denied') {
      this.openReview(applicationId, error.code === 'stale' ? REVIEW_COPY.stale : REVIEW_COPY.denied)
      return
    }
    this.toast(error?.message ?? 'Your Mac could not do that.')
  }

  protected async applyStatus(status: StatusSummary): Promise<void> {
    const at = new Date(this.clock.now()).toISOString()
    // Stored before the frame is acked: the last StatusSummary is the one thing besides keys that outlives the app.
    try {
      await this.deps.vault.saveStatus(status, at)
    } catch (err) {
      throw new StorageError(err instanceof Error ? err.message : undefined)
    }
    this.set({ status, statusAt: at, workspace: { id: status.desktop.workspaceId, name: status.desktop.workspaceName } })
  }

  protected async onEvent(name: string, body: unknown): Promise<void> {
    const event = requireEvent(name, body)
    switch (event.name) {
      case 'status': {
        const before = this.workspaceId()
        await this.applyStatus(event.body)
        if (before !== event.body.desktop.workspaceId) this.refreshQueue()
        return
      }
      case 'queue.changed':
        this.set({ queue: event.body })
        return
      case 'run.changed': {
        this.set({ runInfo: { ...this.snap.runInfo, [event.body.id]: event.body } })
        if (this.snap.runs[event.body.id]) {
          this.setRun(event.body.id, { run: event.body })
          this.refreshRun(event.body.id)
        }
        return
      }
      case 'run.transcript': {
        const view = this.snap.runs[event.body.runId]
        if (view?.complete) this.setRun(event.body.runId, { items: mergeItems(view.items, event.body.seq, event.body.items) })
        return
      }
      case 'pipeline.changed':
        this.set({ pipeline: event.body })
        return
      case 'pipeline.finished':
        this.set({ pipeline: null, lastPipeline: event.body })
        return
      case 'review.needed':
        if (this.snap.reviews) this.loadReviews()
        return
      case 'applications.changed':
        this.onApplicationsChanged(event.body.ids)
        return
      case 'file.chunk':
        this.onChunk(event.body)
        return
      default:
        return
    }
  }

  /**
   * The Mac's application folders changed (`ids: []` means "something changed"): the review list
   * and the open result are fetched again. A result whose files changed gets a new revision;
   * its previews are fetched against the new hashes, and the old ones no longer unlock Approve.
   */
  private onApplicationsChanged(ids: string[]): void {
    if (this.snap.reviews) this.loadReviews()
    const open = this.openReviewId
    if (!open || (ids.length > 0 && !ids.includes(open))) return
    const view = this.snap.review[open]
    // Mid-request the answer may be from before this change: ask again once it lands.
    if (view?.loading) this.reviewRefresh.add(open)
    else if (view?.detail && !view.deciding) this.openReview(open)
  }
}

/**
 * A page covers transcript indexes `since … since + page.length - 1`: those replace what was
 * there (a running tool item updates in place), anything before and after stays.
 */
export function mergeItems(existing: RemoteTranscriptItem[], since: number, page: RemoteTranscriptItem[]): RemoteTranscriptItem[] {
  return [...existing.slice(0, since), ...page, ...existing.slice(since + page.length)]
}

/** The package's URL refusals, in the words of the Jobs screen. */
export function friendlyUrlError(message: string): string {
  if (/credentials/.test(message)) return 'Leave the user name and password out of the link.'
  if (/local|private|public host/.test(message)) return 'That link points at a local or private address. Paste the public job posting.'
  return 'Paste an http(s) link to a job posting.'
}
