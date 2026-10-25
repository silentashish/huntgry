import { randomBytes } from 'node:crypto'
import { localDay, matchReason, matchSkipReason, selectCandidates, type CandidateInput, type SelectContext } from '@shared/automation-select'
import {
  preparedSummary,
  SETTLED_STEPS,
  WORKING_STEPS,
  type AutomationCandidate,
  type AutomationLogEntry,
  type AutomationMatch,
  type AutomationPreview,
  type AutomationRun,
  type AutomationSettings,
  type AutomationState,
  type AutomationStep,
  type PreparedFill
} from '@shared/automation-types'
import type { ApplySession, FillReport } from '@shared/apply-types'
import type { Job } from '@shared/jobs-types'
import { isOpen, nextOpen } from './schedule'
import type { CandidateSource } from './sources'

/**
 * Automation (#154): picks the jobs that match well and prepares each one up to the site's Submit button,
 * through the existing services only. Electron-free; `automation/ipc.ts` injects the app's services, tests
 * inject fakes and a clock.
 *
 * Per candidate, one at a time: save an Explore row to Jobs (`addExplore`), resolve the employer link
 * (`resolveJobrightCopies`, #146), read the full description (`fetchDetails`, with #148's Jobright summary
 * fallback), score it again on that description (#149), tailor it through the unattended pipeline (one
 * pipeline per job, #31), and fill the form in a hidden tab (`ApplyService.prepare`, #24, never submitting).
 * A job that got through lands in Ready to submit.
 *
 * Every step runs once. A step that fails leaves the job in Needs you with the step and the reason, and no
 * later tick or run touches it again until the user presses Retry (one more attempt) or Dismiss. The
 * pipeline's own bounded retries (#31) are the only retries. Waiting (for the run window, the user's apply
 * session, another pipeline, Resume) is not retrying: nothing failed.
 */

export interface TailorResult {
  status: 'done' | 'failed' | 'cancelled' | 'needs-reply'
  outcome?: 'unreviewed' | 'needs-attention' | 'approved' | 'discarded'
  applicationId?: string
  runId?: string
  error?: string
}

/** The unattended pipeline, as Automation uses it (`automation/tailor.ts` adapts the app's pipeline). */
export interface TailorDeps {
  /** Why a pipeline cannot start now (another one is running, the queue is paused with jobs), or `null`. */
  blocked(workspace: string): string | null
  /** Starts a pipeline for this one job; resolves with its queue item once queued. */
  start(workspace: string, jobId: string, options: { automationRunId: string; coverLetter: boolean }): Promise<{ itemId: string }>
  /** Resolves when the item ends: done (with its review outcome), failed, cancelled, or waiting for a reply. */
  wait(itemId: string): Promise<TailorResult>
  /** The item's current state, if the queue still has it (restart recovery). */
  item(itemId: string): TailorResult | 'working' | null
  /** Pause, resume or stop Automation's own pipeline; nothing when the running pipeline is someone else's. */
  pause(workspace: string): Promise<void>
  resume(workspace: string): Promise<void>
  stop(workspace: string): Promise<void>
  /** Median tailoring cost of recent runs (any agent, estimated from tokens), or `null` without history. */
  medianCostUsd(workspace: string): Promise<number | null>
  /** A run's cost, estimated from tokens for every agent (Claude's own figure when there is no estimate). */
  runCostUsd(workspace: string, runId: string): Promise<number>
}

export type PrepareOutcome =
  | { ok: true; fill: Omit<PreparedFill, 'version' | 'applicationId' | 'preparedAt'> }
  | { ok: false; status: string; message: string }

export interface ApplyDepsForAutomation {
  /** The user has an apply session open (or starting): Automation never ends it. */
  busy(): boolean
  prepare(applicationId: string, options: { timeoutMs?: number }): Promise<PrepareOutcome>
  /** The user's open of a prepared fill. */
  start(applicationId: string, seed: Omit<PreparedFill, 'version' | 'applicationId' | 'preparedAt' | 'url' | 'report'>): Promise<ApplySession>
}

export interface AutomationDeps {
  workspace(): Promise<string>
  settings(): Promise<AutomationSettings>
  sources(settings: AutomationSettings): CandidateSource[]
  /** What selection reads besides the candidates: profile signals, saved filters, applications. */
  selection(workspace: string): Promise<Pick<SelectContext, 'signals' | 'filters' | 'applications'>>
  /** The saved job (canonical copy), or `null`. */
  findJob(workspace: string, id: string): Promise<Job | null>
  /** Jobright is connected (the employer link can be looked up). */
  linkConnected(): Promise<boolean>
  /** The job's Jobright page is still its link (no employer link yet). */
  onJobright(job: Job): boolean
  /** `resolveJobrightCopies`: whether any link changed. */
  resolveLink(workspace: string, jobId: string): Promise<boolean>
  /** `fetchDetails` (#148's fallback inside); throws with a message for the user. */
  fetchDetails(workspace: string, jobId: string): Promise<Job>
  /** Relevant's exclusion and the match score of a job, on what it says now. */
  score(workspace: string, job: Job): Promise<{ excluded?: string; match: AutomationMatch }>
  tailor: TailorDeps
  apply: ApplyDepsForAutomation
  /** Approves an Unreviewed result through the review service (the user's click). */
  approve(workspace: string, applicationId: string): Promise<void>
  /** Records the application as applied (the confirmation page after the user's Submit, #154 Q2). */
  markApplied(workspace: string, applicationId: string): Promise<void>
  /** Jobs' Dismiss. */
  dismissJob(workspace: string, jobId: string): Promise<void>
  readState(workspace: string): Promise<AutomationState>
  writeState(workspace: string, state: AutomationState): Promise<void>
  appendLog(workspace: string, entry: AutomationLogEntry): Promise<void>
  writePrepared(workspace: string, fill: PreparedFill): Promise<void>
  readPrepared(workspace: string, applicationId: string): Promise<PreparedFill | null>
  emit(state: AutomationState): void
  emitStep(entry: AutomationLogEntry): void
  notify?(title: string, body: string): void
  now?(): number
  /** Run-window and hold tick; 60 s by default. */
  tickMs?: number
  /** How long one form fill may take. */
  prepareTimeoutMs?: number
}

const ORDER: AutomationStep[] = ['saving', 'link', 'description', 'scoring', 'tailoring', 'filling']

/** Thrown inside a run when it must end now (Stop, workspace switch). */
class RunEnded extends Error {}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const money = (n: number) => `$${n.toFixed(2)}`
const titleOf = (c: Pick<AutomationCandidate, 'title' | 'company'>) => [c.title, c.company].filter(Boolean).join(' · ')
const timeOf = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export class Automation {
  private ws: string | null = null
  private state: AutomationState | null = null
  private loop: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private stopRequested = false
  /** Wakes a run that holds (window, pause, apply session, pipeline). */
  private wakers = new Set<() => void>()
  /** The inputs of the current run's candidates, by key. */
  private inputs = new Map<string, CandidateInput>()
  /** The apply session the user opened from a Ready card, to record the Submit it ends in (#154 Q2). */
  private opened: { ws: string; key: string; sessionId: string } | null = null
  private stopped = false

  constructor(private readonly deps: AutomationDeps) {}

  private now(): Date {
    return new Date(this.deps.now?.() ?? Date.now())
  }

  /** After the window is up: loads the open workspace's state, ends a run a quit interrupted, starts the tick. */
  async init(): Promise<void> {
    await this.sync().catch(() => undefined)
    this.ensureTimer()
  }

  /** Before quit: no new step starts; the running one is left to the services' own shutdown. */
  shutdown(): void {
    this.stopped = true
    this.stopRequested = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.wake()
  }

  private ensureTimer(): void {
    if (this.timer || this.stopped) return
    // No workspace open yet (the picker) is not worth a line every minute; the next tick tries again.
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.deps.tickMs ?? 60_000)
    this.timer.unref?.()
  }

  /** The open workspace's state, loaded once per workspace; a run of another workspace is stopped. */
  private async sync(): Promise<{ ws: string; state: AutomationState }> {
    const ws = await this.deps.workspace()
    if (this.ws === ws && this.state) return { ws, state: this.state }
    if (this.loop) {
      this.stopRequested = true
      this.wake()
      await this.loop.catch(() => undefined)
    }
    const state = await this.deps.readState(ws)
    this.ws = ws
    this.state = state
    await this.recover(ws, state)
    return { ws, state }
  }

  /**
   * A run the app quit (or a workspace switch) interrupted: it ends, and a job that was mid-step goes to Needs you
   * ("Interrupted"), unless its tailoring is still going on in the queue (it is followed again by the next run).
   */
  private async recover(ws: string, state: AutomationState): Promise<void> {
    let changed = false
    for (const c of Object.values(state.candidates)) {
      if (!WORKING_STEPS.has(c.step)) continue
      const item = c.step === 'tailoring' && c.queueItemId ? this.deps.tailor.item(c.queueItemId) : null
      if (item === 'working') continue
      this.fail(c, c.step, 'Interrupted: Huntgry closed (or the workspace changed) during this step.')
      changed = true
    }
    if (state.run && state.run.status !== 'finished') {
      const run = state.run
      run.status = 'stopped'
      run.message = 'Interrupted: Huntgry closed during this run.'
      run.endedAt = this.now().toISOString()
      run.current = undefined
      state.lastRun = run
      state.run = null
      await this.log(ws, run.id, null, 'run', 'info', run.message)
      changed = true
    }
    if (changed) await this.save(ws, state)
  }

  // --- public API (IPC) -------------------------------------------------------------------------

  async getState(): Promise<AutomationState> {
    const { state } = await this.sync()
    state.nextWindowAt = await this.nextWindowAt(state)
    return state
  }

  async setEnabled(on: boolean): Promise<AutomationState> {
    const { ws, state } = await this.sync()
    state.enabled = on
    await this.save(ws, state)
    void this.tick().catch(() => undefined)
    return state
  }

  async pause(): Promise<AutomationState> {
    const { ws, state } = await this.sync()
    state.paused = true
    if (state.run && state.run.status === 'running') {
      state.run.status = 'paused'
      state.run.message = 'Paused by you: the next step waits for Resume.'
    }
    // The job being tailored stops being started or retried; its running turn ends as it would.
    if (state.run) await this.deps.tailor.pause(ws).catch(() => undefined)
    await this.log(ws, state.run?.id ?? '', null, 'run', 'info', 'Paused by you.')
    await this.save(ws, state)
    return state
  }

  async resume(): Promise<AutomationState> {
    const { ws, state } = await this.sync()
    state.paused = false
    if (state.run?.status === 'paused') {
      state.run.status = 'running'
      state.run.message = undefined
      await this.deps.tailor.resume(ws).catch(() => undefined)
    }
    await this.save(ws, state)
    this.wake()
    return state
  }

  /** Starts a run now, whatever the window says; the caps apply. A held run continues instead. */
  async runNow(): Promise<AutomationState> {
    const { ws, state } = await this.sync()
    if (this.stopped) throw new Error('Huntgry is quitting; Automation can no longer start.')
    if (state.run) {
      if (state.run.status === 'waiting') state.run.trigger = 'now'
      this.wake()
      return state
    }
    if (state.paused) state.paused = false
    await this.startRun(ws, state, 'now')
    return state
  }

  /** Ends the run: the job being tailored is stopped and goes back to Selected; nothing else starts. */
  async stop(): Promise<AutomationState> {
    const { ws, state } = await this.sync()
    if (state.run) {
      this.stopRequested = true
      state.run.message = 'Stopping…'
      if (state.run.current && state.candidates[state.run.current]?.step === 'tailoring') await this.deps.tailor.stop(ws).catch(() => undefined)
      await this.save(ws, state)
      this.wake()
    }
    return state
  }

  /** What a run would pick now, without loading anything or changing the state. */
  async preview(): Promise<AutomationPreview> {
    const { ws, state } = await this.sync()
    const settings = await this.deps.settings()
    const { selection } = await this.select(ws, state, settings)
    return selection
  }

  /** One more attempt of a Needs you job's failed step (and the steps after it). */
  async retry(key: string): Promise<AutomationState> {
    const { ws, state } = await this.sync()
    const c = state.candidates[key]
    if (!c || c.step !== 'needs-you') throw new Error('Only a job that needs you can be retried.')
    const from = c.failedStep && ORDER.includes(c.failedStep) ? c.failedStep : 'saving'
    c.step = 'selected'
    c.reasons = [`Retry from "${from}" (one attempt).`, ...c.reasons.filter((r) => !r.startsWith('Retry from'))]
    c.retryFrom = from
    c.error = undefined
    c.failedStep = undefined
    c.updatedAt = this.now().toISOString()
    await this.log(ws, state.run?.id ?? '', c, from, 'info', 'Retry pressed: one more attempt.')
    if (state.run) {
      if (!state.run.candidates.includes(key)) state.run.candidates.push(key)
      await this.save(ws, state)
      this.wake()
    } else {
      await this.startRun(ws, state, 'now', [key])
    }
    return state
  }

  async dismiss(key: string): Promise<AutomationState> {
    const { ws, state } = await this.sync()
    const c = state.candidates[key]
    if (!c) throw new Error('This job is no longer in Automation.')
    if (WORKING_STEPS.has(c.step)) throw new Error('Automation is working on this job; stop the run first.')
    if (c.jobId) await this.deps.dismissJob(ws, c.jobId)
    c.step = 'skipped'
    c.final = true
    c.reasons = ['Dismissed by you.']
    c.error = undefined
    c.failedStep = undefined
    c.updatedAt = this.now().toISOString()
    await this.log(ws, state.run?.id ?? '', c, 'skipped', 'skip', 'Dismissed by you.')
    await this.save(ws, state)
    return state
  }

  async prepared(key: string): Promise<PreparedFill | null> {
    const { ws, state } = await this.sync()
    const c = state.candidates[key]
    return c?.applicationId ? this.deps.readPrepared(ws, c.applicationId) : null
  }

  /**
   * "Review & submit": the user's approval of an Unreviewed result (through the review service), then their
   * apply session, seeded with the prepared answers so nothing asks the model again and the files are attached
   * now. The Submit stays theirs.
   */
  async openPrepared(key: string): Promise<void> {
    const { ws, state } = await this.sync()
    const c = state.candidates[key]
    if (!c || c.step !== 'ready' || !c.applicationId) throw new Error('This job is not ready to submit.')
    await this.deps.approve(ws, c.applicationId)
    const fill = await this.deps.readPrepared(ws, c.applicationId)
    const seed = fill
      ? { drafts: fill.drafts, aiOnce: fill.aiOnce, mappedSteps: fill.mappedSteps, draftedSteps: fill.draftedSteps, asked: fill.asked }
      : { drafts: {}, aiOnce: {}, mappedSteps: [], draftedSteps: [], asked: [] }
    const session = await this.deps.apply.start(c.applicationId, seed)
    this.opened = { ws, key, sessionId: session.id }
    await this.log(ws, state.run?.id ?? '', c, 'ready', 'info', 'Opened the filled form for you; Submit is yours.')
  }

  /** Every apply session change: the confirmation page of a form opened from a Ready card records the application. */
  async onApplySession(session: ApplySession | null): Promise<void> {
    const opened = this.opened
    if (!session || !opened || session.id !== opened.sessionId || session.status !== 'submitted-detected') return
    this.opened = null
    const { ws, state } = await this.sync()
    if (ws !== opened.ws) return
    const c = state.candidates[opened.key]
    if (!c?.applicationId || c.step !== 'ready') return
    await this.deps.markApplied(ws, c.applicationId)
    c.step = 'submitted'
    c.updatedAt = this.now().toISOString()
    await this.log(ws, state.run?.id ?? '', c, 'submitted', 'ok', 'The site confirmed the application; recorded as applied.')
    await this.save(ws, state)
  }

  /** Wakes a holding run (tests move the clock, then call this). */
  wake(): void {
    for (const w of [...this.wakers]) w()
  }

  /** The run window: starts a run once per opening, and lets a held run continue. */
  async tick(): Promise<void> {
    if (this.stopped) return
    const { ws, state } = await this.sync()
    const settings = await this.deps.settings()
    const next = await this.nextWindowAt(state, settings)
    if (next !== state.nextWindowAt) {
      state.nextWindowAt = next
      this.deps.emit(state)
    }
    if (state.run) {
      this.wake()
      return
    }
    if (!state.enabled || state.paused || !isOpen(settings.window, this.now())) return
    // One run per opening of the window: a window run that ended in this opening (finished early, or held over from
    // the last one) is not followed by another until the next opening.
    const opened = this.windowOpenedAt(settings, this.now())
    const last = state.lastRun
    if (last && last.trigger === 'window' && opened && Date.parse(last.endedAt ?? last.startedAt) >= opened.getTime()) return
    await this.startRun(ws, state, 'window')
  }

  // --- the run ------------------------------------------------------------------------------------

  private async nextWindowAt(state: AutomationState, settings?: AutomationSettings): Promise<string | null> {
    if (!state.enabled) return null
    const s = settings ?? (await this.deps.settings())
    return nextOpen(s.window, this.now())?.toISOString() ?? null
  }

  /** When the window that is open now opened (the previous start time), or `null` when it is closed. */
  private windowOpenedAt(settings: AutomationSettings, now: Date): Date | null {
    const w = settings.window
    if (w.mode === 'anytime') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (!isOpen(w, now)) return null
    const [h, m] = w.start.split(':').map(Number)
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m)
    if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1)
    return start
  }

  private async select(ws: string, state: AutomationState, settings: AutomationSettings) {
    const now = this.now()
    const lists = await Promise.all(this.deps.sources(settings).map((s) => s.list(ws).then((inputs) => ({ source: s, inputs })).catch(() => ({ source: s, inputs: [] }))))
    const inputs = lists.flatMap((l) => l.inputs)
    const ctx = await this.deps.selection(ws)
    const selection = selectCandidates(inputs, { ...ctx, candidates: state.candidates, day: state.day, settings, now, today: localDay(now) })
    return { selection, inputs, lists }
  }

  private async startRun(ws: string, state: AutomationState, trigger: AutomationRun['trigger'], only?: string[]): Promise<void> {
    if (this.loop) return
    const settings = await this.deps.settings()
    const now = this.now()
    const run: AutomationRun = {
      id: `a-${localDay(now).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`,
      startedAt: now.toISOString(),
      status: 'running',
      trigger,
      costUsd: 0,
      pageLoads: 0,
      candidates: []
    }
    this.inputs.clear()
    const { selection, inputs } = await this.select(ws, state, settings)
    for (const input of inputs) this.inputs.set(input.key, input)
    if (only) {
      run.candidates = only.filter((k) => state.candidates[k])
    } else {
      for (const c of selection.skipped) {
        const prior = state.candidates[c.key]
        if (prior && (SETTLED_STEPS.has(prior.step) || WORKING_STEPS.has(prior.step))) continue
        state.candidates[c.key] = { ...c, automationRunId: run.id }
      }
      for (const c of selection.picked) {
        state.candidates[c.key] = { ...c, automationRunId: run.id }
        run.candidates.push(c.key)
      }
    }
    this.stopRequested = false
    state.run = run
    await this.log(ws, run.id, null, 'run', 'start', `${trigger === 'now' ? 'Run now' : 'Run window'}: ${run.candidates.length} job${run.candidates.length === 1 ? '' : 's'} picked.`)
    if (!only) for (const c of selection.skipped) await this.log(ws, run.id, c, 'skipped', 'skip', c.reasons[0] ?? 'Skipped.')
    await this.save(ws, state)
    this.loop = this.drive(ws, state, run)
      .catch((err: unknown) => console.error('Automation run failed:', err))
      .finally(() => {
        this.loop = null
      })
  }

  private async drive(ws: string, state: AutomationState, run: AutomationRun): Promise<void> {
    let status: AutomationRun['status'] = 'finished'
    let why: string | undefined
    try {
      for (let i = 0; i < run.candidates.length; i++) {
        const c = state.candidates[run.candidates[i]]
        if (!c || c.step !== 'selected') continue
        const end = await this.process(ws, state, run, c)
        if (end) {
          status = end.status
          why = end.message
          break
        }
      }
    } catch (err) {
      status = 'stopped'
      why = err instanceof RunEnded ? err.message : `Stopped: ${message(err)}`
    }
    if (state !== this.state) return
    run.status = status
    run.message = why
    run.current = undefined
    run.endedAt = this.now().toISOString()
    state.lastRun = run
    state.run = null
    this.stopRequested = false
    const ready = run.candidates.filter((k) => state.candidates[k]?.step === 'ready').length
    const needs = run.candidates.filter((k) => state.candidates[k]?.step === 'needs-you').length
    await this.log(ws, run.id, null, 'run', 'info', `Run ${status === 'finished' ? 'finished' : 'ended'}: ${ready} ready to submit, ${needs} need you, ${money(run.costUsd)} tailoring.${why ? ` ${why}` : ''}`)
    await this.save(ws, state)
    if (ready || needs) this.deps.notify?.('Huntgry Automation', `${ready} ready to submit · ${needs} need you`)
  }

  /**
   * Holds the run while `reason()` says so (window closed, paused, a session or pipeline to wait for), waking on
   * the tick, Resume, Run now and Stop. Ends the run on Stop or a workspace switch.
   */
  private async hold(ws: string, state: AutomationState, run: AutomationRun, reason: () => Promise<{ status: 'paused' | 'waiting'; message: string } | null>): Promise<void> {
    for (;;) {
      await this.checkAlive(ws, state)
      const r = await reason()
      if (!r) break
      if (run.status !== r.status || run.message !== r.message) {
        run.status = r.status
        run.message = r.message
        await this.log(ws, run.id, null, 'run', 'info', r.message)
        await this.save(ws, state)
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          this.wakers.delete(done)
          clearTimeout(t)
          resolve()
        }
        const t = setTimeout(done, this.deps.tickMs ?? 60_000)
        this.wakers.add(done)
      })
    }
    if (run.status !== 'running') {
      run.status = 'running'
      run.message = undefined
      await this.save(ws, state)
    }
  }

  private async checkAlive(ws: string, state: AutomationState): Promise<void> {
    if (this.stopRequested || state !== this.state) throw new RunEnded(this.stopped ? 'Huntgry is quitting.' : 'Stopped by you.')
    const current = await this.deps.workspace().catch(() => null)
    if (current !== ws) throw new RunEnded('Stopped: the workspace changed.')
  }

  /** Before each step: pause, and the window (a window run holds when it closes; Run now ignores it). */
  private async gate(ws: string, state: AutomationState, run: AutomationRun): Promise<void> {
    await this.hold(ws, state, run, async () => {
      if (state.paused) return { status: 'paused', message: 'Paused by you: the next step waits for Resume.' }
      if (run.trigger === 'window') {
        const settings = await this.deps.settings()
        const now = this.now()
        if (!isOpen(settings.window, now)) {
          const at = nextOpen(settings.window, now)
          return { status: 'waiting', message: `The run window closed; continues at ${at ? timeOf(at) : 'its next opening'}.` }
        }
      }
      return null
    })
  }

  /**
   * One candidate through its steps. Returns how the run ends when a cap stops it (the candidate then stays
   * Selected), or nothing to go on with the next candidate.
   */
  private async process(ws: string, state: AutomationState, run: AutomationRun, c: AutomationCandidate): Promise<{ status: AutomationRun['status']; message: string } | void> {
    const settings = await this.deps.settings()
    const from = c.retryFrom
    c.retryFrom = undefined
    const start = from ? ORDER.indexOf(from) : 0
    run.current = c.key
    const at = (step: AutomationStep) => ORDER.indexOf(step) >= start

    // Saving an Explore row (and, while connected, its employer link: one Jobright page).
    if (!c.jobId) {
      await this.gate(ws, state, run)
      if (run.pageLoads >= settings.maxExplorePageLoads) {
        c.reasons = [`Waits for the next run: at most ${settings.maxExplorePageLoads} Jobright pages per run.`, ...c.reasons.filter((r) => !r.startsWith('Waits for'))]
        await this.save(ws, state)
        return
      }
      const input = this.inputs.get(c.key)
      const source = input ? this.deps.sources(settings).find((s) => s.id === input.source) : undefined
      if (!input || !source) return this.failed(ws, state, run, c, 'saving', 'This job is no longer on its list.')
      await this.begin(ws, state, run, c, 'saving', 'Saving to Jobs.')
      try {
        if (await this.deps.linkConnected().catch(() => false)) run.pageLoads++
        const jobId = await source.materialize(ws, input)
        this.rekey(state, run, c, jobId)
        await this.done(ws, state, run, c, 'Saved to Jobs.')
      } catch (err) {
        return this.failed(ws, state, run, c, 'saving', `Couldn't save it to Jobs: ${message(err)}`)
      }
    }
    const jobId = c.jobId as string

    if (at('link')) {
      await this.gate(ws, state, run)
      const job = await this.deps.findJob(ws, jobId)
      if (!job) return this.failed(ws, state, run, c, 'link', 'This job is no longer saved.')
      if (this.deps.onJobright(job)) {
        await this.begin(ws, state, run, c, 'link', 'Looking up the employer link on Jobright.')
        if (!(await this.deps.linkConnected().catch(() => false))) {
          await this.done(ws, state, run, c, 'Jobright is not connected: the job keeps its Jobright link.', 'skip')
        } else if (run.pageLoads >= settings.maxExplorePageLoads) {
          await this.done(ws, state, run, c, `No lookup: at most ${settings.maxExplorePageLoads} Jobright pages per run.`, 'skip')
        } else {
          run.pageLoads++
          const changed = await this.deps.resolveLink(ws, jobId).catch(() => false)
          // Signed out or no link given is not a failure: the description and the fill go on with the Jobright page.
          await this.done(ws, state, run, c, changed ? 'Employer link found.' : 'No employer link (signed out, or Jobright gives none).', changed ? 'ok' : 'skip')
        }
      } else if (job.source === 'jobright' && job.boardUrl && job.url !== job.boardUrl) {
        // Saving it to Jobs while connected already looked the link up (#146): said here, so the log reads in order.
        await this.begin(ws, state, run, c, 'link', 'Looking up the employer link on Jobright.')
        await this.done(ws, state, run, c, 'Employer link found when it was saved to Jobs.')
      }
    }

    if (at('description')) {
      await this.gate(ws, state, run)
      const job = await this.deps.findJob(ws, jobId)
      if (!job) return this.failed(ws, state, run, c, 'description', 'This job is no longer saved.')
      if (!job.descriptionComplete) {
        await this.begin(ws, state, run, c, 'description', 'Reading the full description.')
        try {
          if (job.source === 'jobright') run.pageLoads++
          const full = await this.deps.fetchDetails(ws, jobId)
          if (!full.descriptionComplete) return this.failed(ws, state, run, c, 'description', 'Only part of the posting could be read.')
          await this.done(ws, state, run, c, full.descriptionSource === 'jobright-summary' ? "Read Jobright's summary (the employer page has no description)." : 'Read the full description.')
        } catch (err) {
          return this.failed(ws, state, run, c, 'description', `Couldn't read the description: ${message(err)}`)
        }
      }
    }

    if (at('scoring')) {
      await this.gate(ws, state, run)
      const job = await this.deps.findJob(ws, jobId)
      if (!job) return this.failed(ws, state, run, c, 'scoring', 'This job is no longer saved.')
      await this.begin(ws, state, run, c, 'scoring', 'Scoring the full description.')
      const scored = await this.deps.score(ws, job)
      c.match = scored.match
      const why = scored.excluded ? `${scored.excluded}.` : matchSkipReason(scored.match, settings)
      if (why) {
        c.step = 'skipped'
        c.final = true
        c.reasons = [why, matchReason(scored.match)]
        c.updatedAt = this.now().toISOString()
        await this.log(ws, run.id, c, 'scoring', 'skip', why)
        await this.save(ws, state)
        return
      }
      c.reasons = [matchReason(scored.match), ...c.reasons.filter((r) => !r.startsWith('Match ') && !r.startsWith('Scored once'))]
      await this.done(ws, state, run, c, `${matchReason(scored.match)}: picked.`)
    }

    if (at('tailoring')) {
      await this.gate(ws, state, run)
      // Per day: the jobs that entered tailoring today, across runs.
      const today = localDay(this.now())
      if (state.day.date !== today) state.day = { date: today, started: 0 }
      if (state.day.started >= settings.perDay) {
        const reason = `Cap: ${settings.perDay} a day.`
        for (const key of run.candidates) {
          const other = state.candidates[key]
          if (other && other.step === 'selected') {
            other.step = 'skipped'
            other.reasons = [reason, ...other.reasons.filter((r) => !r.startsWith('Cap:'))]
            other.updatedAt = this.now().toISOString()
          }
        }
        await this.save(ws, state)
        return { status: 'stopped-cap', message: `Daily cap reached (${settings.perDay} jobs today).` }
      }
      // Per run cost: the next job would likely cost the median of recent runs.
      const median = (await this.deps.tailor.medianCostUsd(ws).catch(() => null)) ?? 0
      if (run.costUsd + median > settings.maxCostUsd) {
        await this.log(ws, run.id, c, 'tailoring', 'skip', `Cost cap: ${money(run.costUsd)} spent + ~${money(median)} for the next job is over ${money(settings.maxCostUsd)}.`)
        return { status: 'stopped-cost', message: `Cost cap reached (${money(run.costUsd)} of ${money(settings.maxCostUsd)}).` }
      }
      await this.hold(ws, state, run, async () => {
        const blocked = this.deps.tailor.blocked(ws)
        return blocked ? { status: 'waiting', message: blocked } : null
      })
      await this.begin(ws, state, run, c, 'tailoring', 'Tailoring through the unattended pipeline.')
      let result: TailorResult
      try {
        const { itemId } = await this.deps.tailor.start(ws, jobId, { automationRunId: run.id, coverLetter: settings.coverLetter })
        c.queueItemId = itemId
        state.day.started++
        await this.save(ws, state)
        result = await this.deps.tailor.wait(itemId)
      } catch (err) {
        return this.failed(ws, state, run, c, 'tailoring', `Couldn't start tailoring: ${message(err)}`)
      }
      if (result.runId) {
        c.runId = result.runId
        const cost = await this.deps.tailor.runCostUsd(ws, result.runId).catch(() => 0)
        c.costUsd = cost
        run.costUsd = Math.round((run.costUsd + cost) * 100) / 100
      }
      if (result.applicationId) c.applicationId = result.applicationId
      if (result.status === 'cancelled' && this.stopRequested) {
        c.step = 'selected'
        await this.log(ws, run.id, c, 'tailoring', 'info', 'Tailoring stopped with the run; the job waits for the next one.')
        await this.save(ws, state)
        throw new RunEnded('Stopped by you.')
      }
      if (result.status !== 'done' || !result.applicationId) {
        const why =
          result.status === 'needs-reply'
            ? 'The tailoring run stopped with a question.'
            : result.status === 'cancelled'
              ? 'Tailoring was cancelled.'
              : `Tailoring failed${result.error ? `: ${result.error}` : '.'}`
        return this.failed(ws, state, run, c, 'tailoring', why)
      }
      if (result.outcome === 'needs-attention' || result.outcome === 'discarded') {
        return this.failed(ws, state, run, c, 'tailoring', result.outcome === 'discarded' ? 'The result was discarded on Review.' : 'The result needs attention on Review (verify or notes missing).')
      }
      await this.done(ws, state, run, c, `Tailored${c.costUsd ? ` (${money(c.costUsd)})` : ''}: waiting for your review.`, 'ok', c.costUsd)
    }

    // Filling: the form in a hidden tab, never submitted, never while the user has an apply session.
    await this.gate(ws, state, run)
    if (!c.applicationId) return this.failed(ws, state, run, c, 'filling', 'No application to fill.')
    await this.hold(ws, state, run, async () => (this.deps.apply.busy() ? { status: 'waiting', message: 'Waiting for your apply session to end.' } : null))
    await this.begin(ws, state, run, c, 'filling', 'Filling the application form (it is not submitted).')
    let outcome: PrepareOutcome
    try {
      outcome = await this.deps.apply.prepare(c.applicationId, { timeoutMs: this.deps.prepareTimeoutMs })
    } catch (err) {
      return this.failed(ws, state, run, c, 'filling', `Couldn't fill the form: ${message(err)}`)
    }
    if (!outcome.ok) return this.failed(ws, state, run, c, 'filling', outcome.message)
    const preparedAt = this.now().toISOString()
    const fill: PreparedFill = { version: 1, applicationId: c.applicationId, preparedAt, ...outcome.fill }
    await this.deps.writePrepared(ws, fill)
    c.prepared = preparedSummary(fill.report as FillReport, preparedAt)
    c.step = 'ready'
    c.updatedAt = preparedAt
    const p = c.prepared
    await this.log(ws, run.id, c, 'filling', 'ok', `Filled ${p.filled} field${p.filled === 1 ? '' : 's'} (${p.ai} by AI, ${p.openRequired} required left, ${p.uploadsDeferred} file${p.uploadsDeferred === 1 ? '' : 's'} attached when you open it). Ready to submit.`)
    await this.save(ws, state)
  }

  /** An Explore row saved to Jobs: its record moves to the saved job's id. */
  private rekey(state: AutomationState, run: AutomationRun, c: AutomationCandidate, jobId: string): void {
    const old = c.key
    c.jobId = jobId
    if (old === jobId) return
    delete state.candidates[old]
    c.key = jobId
    state.candidates[jobId] = c
    run.candidates = run.candidates.map((k) => (k === old ? jobId : k))
    run.current = jobId
    const input = this.inputs.get(old)
    if (input) this.inputs.set(jobId, { ...input, key: jobId, savedJobId: jobId })
  }

  private async begin(ws: string, state: AutomationState, run: AutomationRun, c: AutomationCandidate, step: AutomationStep, text: string): Promise<void> {
    await this.checkAlive(ws, state)
    c.step = step
    c.updatedAt = this.now().toISOString()
    await this.log(ws, run.id, c, step, 'start', text)
    await this.save(ws, state)
  }

  private async done(ws: string, state: AutomationState, run: AutomationRun, c: AutomationCandidate, text: string, outcome: 'ok' | 'skip' = 'ok', costUsd?: number): Promise<void> {
    await this.log(ws, run.id, c, c.step, outcome, text, costUsd)
    c.step = 'selected'
    c.updatedAt = this.now().toISOString()
    await this.save(ws, state)
  }

  private fail(c: AutomationCandidate, step: AutomationStep, why: string): void {
    c.step = 'needs-you'
    c.failedStep = step
    c.error = why
    c.updatedAt = this.now().toISOString()
  }

  /** A step failed: Needs you, logged once; the run goes on with the next job. */
  private async failed(ws: string, state: AutomationState, run: AutomationRun, c: AutomationCandidate, step: AutomationStep, why: string): Promise<void> {
    this.fail(c, step, why)
    await this.log(ws, run.id, c, step, 'fail', why)
    await this.save(ws, state)
  }

  private async log(ws: string, runId: string, c: Pick<AutomationCandidate, 'key' | 'title' | 'company'> | null, step: AutomationLogEntry['step'], outcome: AutomationLogEntry['outcome'], text: string, costUsd?: number): Promise<void> {
    const entry: AutomationLogEntry = {
      at: this.now().toISOString(),
      runId,
      key: c?.key ?? '',
      ...(c ? { title: titleOf(c) } : {}),
      step,
      outcome,
      message: text,
      ...(costUsd !== undefined ? { costUsd } : {})
    }
    await this.deps.appendLog(ws, entry).catch((err: unknown) => console.error('Writing the automation log failed:', err))
    this.deps.emitStep(entry)
  }

  private async save(ws: string, state: AutomationState): Promise<void> {
    if (state !== this.state) return
    await this.deps.writeState(ws, state)
    this.deps.emit(state)
  }
}
