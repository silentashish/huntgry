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
  requireHelloBody,
  requireQueueState,
  requireRemoteRun,
  requireRunPage,
  requireStatusSummary,
  requireEvent,
  type Envelope,
  type EnvelopeError,
  type NotificationCategory,
  type PipelineState,
  type PipelineSummary,
  type RelayNotice,
  type RemoteQueueState,
  type RemoteRun,
  type RemoteTranscriptItem,
  type StatusSummary
} from '@huntgry/remote-protocol'
import { commandLabel, commands, NoWorkspaceError, type Command, type DeliveryState } from './commands'
import { PairingFlow, PairingError, type PairingStep } from './pairing'
import { systemClock, type Clock, type SocketFactory } from './platform'
import { RelayClient, StorageError, type ConnectionState, type FatalReason, type SentCommand } from './relay'
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
  private toastSeq = 0
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
    client.start()
  }

  /** App foregrounded / network back. */
  wake(): void {
    this.client?.wake()
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

  /** The owner unpairs this phone (revoke it on the Mac too). */
  async unpair(): Promise<void> {
    this.stop()
    await this.deps.vault.wipe()
    this.requests.clear()
    this.set({ ...INITIAL_SNAPSHOT, phase: 'unpaired', demo: this.snap.demo })
  }

  private async onFatal(reason: FatalReason, message: string): Promise<void> {
    this.client = null
    // Pair again: every key and counter goes; the next pairing mints a new identity.
    await this.deps.vault.wipe()
    this.requests.clear()
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
    const command = this.requests.get(id)
    if (command?.name === 'run.get' && (state === 'expired' || state === 'too-large' || state === 'failed')) {
      // A quiet request with no command row: the run would stay loading and refuse every retry.
      this.requests.delete(id)
      const message = state === 'expired' ? 'Your Mac did not answer in time.' : (error?.message ?? 'Could not load this run.')
      this.setRun(command.args.runId, { loading: false, error: message })
      return
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
      default:
        return
    }
  }

  private onFailure(command: Command, error: EnvelopeError | undefined): void {
    if (command.name === 'run.get') {
      this.setRun(command.args.runId, { loading: false, error: error?.message ?? 'Could not load this run.' })
      return
    }
    if (command.name === 'status.get' || command.name === 'queue.get') return
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
      default:
        return // review.needed, applications.changed, file.chunk: #40 / #42
    }
  }
}

/**
 * A page covers transcript indexes `since … since + page.length - 1`: those replace what was
 * there (a running tool item updates in place), anything before and after stays.
 */
export function mergeItems(existing: RemoteTranscriptItem[], since: number, page: RemoteTranscriptItem[]): RemoteTranscriptItem[] {
  return [...existing.slice(0, since), ...page, ...existing.slice(since + page.length)]
}
