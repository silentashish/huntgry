/**
 * Demo mode (`EXPO_PUBLIC_DEMO=1`): the Figma file's sample data, no relay, nothing stored.
 * Commands are answered by a pretend Mac a moment later, so every screen can be tried and
 * screenshotted without a desktop. On the web, `?demo=offline|unpaired|waiting|denied`
 * shows the other states.
 */

import { NOTIFICATION_CATEGORIES, type PipelineState, type RemoteQueueItem, type RemoteRun, type RemoteTranscriptItem, type StatusSummary } from '@huntgry/remote-protocol'
import type { Command } from '../remote/commands'
import { INITIAL_SNAPSHOT, RemoteModel, type RemoteSnapshot } from '../remote/model'
import { MemoryStorage } from '../remote/platform'
import { Vault, type Pairing } from '../remote/vault'

const MIN = 60_000

function variant(): string {
  const g = globalThis as { location?: { search?: string } }
  const m = /[?&]demo=([a-z]+)/.exec(g.location?.search ?? '')
  return m ? m[1] : ''
}

function at(now: number, offsetMs: number): string {
  return new Date(now + offsetMs).toISOString()
}

/** Today at hh:mm (local). */
function today(now: number, h: number, m: number): string {
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

export function demoData(now: number) {
  const pairing: Pairing = {
    relay: 'https://huntgry-relay.ashish.workers.dev',
    room: 'demo',
    deviceId: 'demo-phone',
    relayToken: '0'.repeat(64),
    desktopPublicKey: '0'.repeat(64),
    sessionKey: 'A'.repeat(43) + '=',
    sid: 'demo',
    desktopName: "Ashish's MacBook Pro",
    deviceName: "Ashish's iPhone",
    pairedAt: at(now, -3 * 86_400_000),
    categories: NOTIFICATION_CATEGORIES.filter((c) => c !== 'failed')
  }
  const status: StatusSummary = {
    desktop: { name: "Ashish's MacBook Pro", appVersion: '0.1.0', workspaceName: 'The den', workspaceId: 'd'.repeat(32) },
    queue: { active: 14, needsReply: 2, failed: 1, paused: false },
    pipeline: { status: 'running' },
    review: { unreviewed: 4 },
    agents: [
      { id: 'claude', ready: true },
      { id: 'codex', ready: true },
      { id: 'antigravity', ready: false }
    ]
  }
  const run = (id: string, title: string, agent: RemoteRun['agent'], status: RemoteRun['status'], startedMsAgo: number, tokens: number, cost: number): RemoteRun => ({
    id,
    title,
    agent,
    status,
    job: { company: title.split(' · ')[0], role: title.split(' · ')[1] },
    options: { coverLetter: true, dateStyle: 'inline' },
    createdAt: at(now, -startedMsAgo),
    updatedAt: at(now, -5_000),
    files: [],
    costUsd: cost,
    usage: { inputTokens: Math.round(tokens * 0.8), outputTokens: Math.round(tokens * 0.2) },
    live: status === 'running' || status === 'waiting'
  })
  const runs: Record<string, RemoteRun> = {
    'run-stripe': run('run-stripe', 'Stripe · Sr Backend Engineer', 'claude', 'waiting', 252_000, 61_000, 0.44),
    'run-notion': run('run-notion', 'Notion · Product Engineer, Growth', 'claude', 'running', 72_000, 18_000, 0)
  }
  const item = (over: Partial<RemoteQueueItem> & Pick<RemoteQueueItem, 'id' | 'title' | 'agent' | 'status'>): RemoteQueueItem => ({
    jobId: `url:${over.id.padEnd(16, '0').slice(0, 16)}`,
    runId: null,
    attempts: 1,
    hasPendingReply: false,
    createdAt: at(now, -40 * MIN),
    updatedAt: at(now, -2 * MIN),
    ...over
  })
  const doneTitles = ['Linear · Senior Engineer', 'Vercel · Platform Engineer', 'Figma · Backend Engineer', 'Plaid · Software Engineer', 'Retool · Full-stack Engineer', 'Airtable · Infra Engineer', 'Brex · Payments Engineer', 'Mercury · Backend Engineer', 'Rippling · Platform Engineer']
  const items: RemoteQueueItem[] = [
    item({ id: 'item-stripe', title: 'Stripe · Senior Backend Engineer', agent: 'claude', status: 'needs-reply', runId: 'run-stripe' }),
    item({ id: 'item-notion', title: 'Notion · Product Engineer, Growth', agent: 'claude', status: 'running', runId: 'run-notion' }),
    item({ id: 'item-datadog', title: 'Datadog · Staff Engineer, Infra', agent: 'codex', status: 'queued', attempts: 2, notBefore: at(now, 5 * MIN + 10_000), error: 'Usage limit reached; retrying.' }),
    item({ id: 'item-ramp', title: 'Ramp · Backend Engineer', agent: 'codex', status: 'queued' }),
    ...doneTitles.map((title, i) => item({ id: `item-done-${i}`, title, agent: i % 3 === 0 ? 'codex' : 'claude', status: 'done', built: true, runId: null, updatedAt: at(now, -(i + 1) * 9 * MIN) }))
  ]
  const pipeline: PipelineState = {
    status: 'running',
    agent: 'claude',
    counts: { total: 20, done: 5, running: 3, queued: 12, failed: 0, unreviewed: 4 },
    waitingLimitUntil: today(now, 14, 5),
    eta: at(now, 40 * MIN),
    startedAt: at(now, -50 * MIN),
    updatedAt: at(now, -MIN)
  }
  const transcript: RemoteTranscriptItem[] = [
    { kind: 'assistant', id: 'demo-1', text: 'Gap analysis done. R1 · Kafka → SQS/SNS pipeline. R2 · Ledger correctness → billing ledger at Notion. Open gaps: gRPC, Rust.\n\nApprove R1 and R2 as worded?' },
    { kind: 'user', id: 'demo-2', text: 'Approve R1. R2: say “contributed to”.' },
    { kind: 'tool', id: 'demo-3', name: 'Bash', summary: 'building resume.pdf', status: 'running' }
  ]
  return { pairing, status, runs, items, pipeline, transcript }
}

export class DemoModel extends RemoteModel {
  private readonly data = demoData(Date.now())

  constructor() {
    super({ vault: new Vault(new MemoryStorage()), socket: () => { throw new Error('demo') }, appVersion: '0.1.0', deviceName: "Ashish's iPhone" })
  }

  override async init(): Promise<void> {
    const v = variant()
    const now = Date.now()
    const base: RemoteSnapshot = {
      ...INITIAL_SNAPSHOT,
      demo: true,
      phase: 'paired',
      connection: 'online',
      pairing: this.data.pairing,
      presence: { online: true, since: at(now, -2 * 3_600_000), queued: 0 },
      status: this.data.status,
      statusAt: at(now, -10_000),
      workspace: { id: this.data.status.desktop.workspaceId, name: 'The den' },
      queue: { items: this.data.items, concurrency: 2, paused: false, more: 10 },
      pipeline: this.data.pipeline,
      runInfo: this.data.runs
    }
    if (v === 'offline') {
      base.presence = { online: false, since: at(now, -23 * MIN), queued: 2 }
      base.commands = [
        { id: 'demo-cmd-1', name: 'pipeline.pause', label: 'Pause pipeline', state: 'queued', at: now - 2 * MIN },
        { id: 'demo-cmd-2', name: 'run.reply', label: 'Reply · Stripe run', state: 'expired', at: now - 20 * MIN, runId: 'run-stripe' }
      ]
    }
    if (v === 'unpaired' || v === 'waiting' || v === 'denied' || v === 'again') {
      this.set({ ...INITIAL_SNAPSHOT, demo: true, phase: 'unpaired', pairAgain: v === 'again' ? { reason: 'denied', message: 'This phone must be paired again.' } : null })
      if (v === 'waiting') {
        const invite = { v: 1 as const, relay: this.data.pairing.relay, room: 'demo', pairing: 'demo', desktopPublicKey: new Uint8Array(32), secret: new Uint8Array(32), exp: Math.floor(now / 1000) + 102 }
        this.set({ pairingStep: { step: 'waiting', invite, queued: false } })
      }
      if (v === 'denied') this.set({ pairingStep: { step: 'denied' } })
      return
    }
    this.set(base)
  }

  override async pair(qrText: string): Promise<void> {
    void qrText
    this.set({ pairingStep: { step: 'error', message: 'Demo mode: pairing needs a Mac. Run the app without EXPO_PUBLIC_DEMO.' } })
  }

  override async unpair(): Promise<void> {
    this.set({ ...INITIAL_SNAPSHOT, demo: true, phase: 'unpaired' })
  }

  override wake(): void {}

  /** The pretend Mac answers after a beat. */
  protected override dispatch(command: Command, meta: { runId?: string; itemId?: string; quiet?: boolean } = {}): string | null {
    const id = `demo-${Math.random().toString(36).slice(2)}`
    this.track(id, command, meta)
    this.setCommand(id, 'sent')
    setTimeout(() => this.answer(id, command), 450)
    return id
  }

  private setCommand(id: string, state: RemoteSnapshot['commands'][number]['state']): void {
    this.set({ commands: this.snap.commands.map((c) => (c.id === id ? { ...c, state } : c)) })
  }

  private answer(id: string, command: Command): void {
    const queue = this.snap.queue
    switch (command.name) {
      case 'queue.setPaused':
        if (queue) this.set({ queue: { ...queue, paused: command.args.paused } })
        break
      case 'queue.cancel':
        if (queue) this.set({ queue: { ...queue, items: queue.items.map((i) => (i.id === command.args.itemId ? { ...i, status: 'cancelled' } : i)) } })
        break
      case 'queue.retry':
        if (queue) this.set({ queue: { ...queue, items: queue.items.map((i) => (i.id === command.args.itemId ? { ...i, status: 'queued', attempts: i.attempts + 1 } : i)) } })
        break
      case 'pipeline.pause':
      case 'pipeline.resume':
        if (this.snap.pipeline) this.set({ pipeline: { ...this.snap.pipeline, status: command.name === 'pipeline.pause' ? 'paused' : 'running' } })
        break
      case 'pipeline.stop':
        this.set({ pipeline: null })
        break
      case 'run.get': {
        const run = this.data.runs[command.args.runId] ?? this.data.runs['run-stripe']
        const items = command.args.runId === 'run-stripe' ? this.data.transcript : []
        this.set({ runs: { ...this.snap.runs, [command.args.runId]: { run, items, complete: true, loading: false } } })
        break
      }
      case 'run.reply': {
        const view = this.snap.runs[command.args.runId]
        if (view) {
          const items: RemoteTranscriptItem[] = [...view.items, { kind: 'user', id: `demo-${id}`, text: command.args.text }]
          this.set({ runs: { ...this.snap.runs, [command.args.runId]: { ...view, items, run: view.run ? { ...view.run, status: 'running' } : null } } })
        }
        break
      }
      case 'run.finish':
      case 'run.stop': {
        const view = this.snap.runs[command.args.runId]
        if (view?.run) this.set({ runs: { ...this.snap.runs, [command.args.runId]: { ...view, run: { ...view.run, status: command.name === 'run.finish' ? 'finished' : 'stopped', live: false } } } })
        break
      }
      default:
        break
    }
    this.setCommand(id, 'done')
  }
}
