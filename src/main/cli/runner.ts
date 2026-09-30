import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { AGENT_LABEL, DEFAULT_AGENT, type AgentId, type RunSummary, type StartRunParams } from '@shared/runner-types'
import { LineBuffer, parseEventLine, type HuntgryEvent } from '@shared/transcript'
import { buildFirstPrompt, runTitle, type SandboxPaths } from './command'
import { recordJobSource } from '../applications/tracking'
import { adapterFor, type AgentAdapter } from './agents'
import { appendEvent, findOutputFolder, newRunId, readEvents, readRun, saveRun } from './runs'

/**
 * Owns the agent child processes of tailoring runs (see `agents/` for what
 * differs per CLI). A `stream` agent (claude, agy) keeps one process per run
 * alive between turns, so replies go straight to stdin; an `exec` agent
 * (codex) runs one process per turn. A run whose process is gone is resumed
 * with its session id. Every stdout line is appended to the run's
 * `events.jsonl` and forwarded to the renderer.
 */

export interface RunContext {
  /** Agent CLI of this run; Claude when absent. */
  agent?: AgentId
  workspace: string
  skillDir: string
  /** Paths the child's OS sandbox may read (see `buildSandboxSettings`). */
  sandbox: SandboxPaths
  /** Executable to spawn (the agent's binary; a fake script in tests). */
  command: string
  /** Arguments placed before the agent's arguments (e.g. the fake script path). */
  commandPrefixArgs?: string[]
  env: NodeJS.ProcessEnv
  systemPrompt: string
  model?: string
  /** The agent CLI's version, `null` when unknown; used for the error message of a failed run. */
  claudeVersion?: string | null
  /** The CLI accepts `--permission-prompts none` (≥ 2.1.259). */
  permissionPrompts?: boolean
}

export interface RunnerHooks {
  /** `seq` is the event's index in the run's `events.jsonl`. */
  onEvent(runId: string, seq: number, event: unknown): void
  onRun(run: RunSummary): void
}

interface Live {
  child: ChildProcessWithoutNullStreams
  run: RunSummary
  ctx: RunContext
  adapter: AgentAdapter
  stderr: string
  /** The current turn ended (the agent waits); reset by the next `send`. */
  turnEnded: boolean
  /** Why the last turn failed, as the agent reported it (cleared by a good turn). */
  turnError?: string
  /** Items the agent produced in the current turn (messages, commands, edits). */
  turnContent: number
  /** Serializes disk writes of this run so events keep their order. */
  queue: Promise<void>
  /** Index the next recorded event gets in `events.jsonl`. */
  seq: number
  stopping: boolean
  /** Set by `abort()`: the run fails with this reason when the process exits. */
  aborted?: string
  finishing: boolean
  turnStartedAt: number
}

const STDERR_TAIL = 4000

export class RunManager {
  private live = new Map<string, Live>()
  /** Writes still pending for runs whose process has exited. */
  private settling = new Set<Promise<void>>()
  /** Per run: the pending writes of its last process, until they are on disk. */
  private settledById = new Map<string, Promise<void>>()
  /** Per run: the chain of resumes and ends of a run with no process (see `idle`). */
  private idleOps = new Map<string, Promise<unknown>>()

  constructor(private hooks: RunnerHooks) {}

  isLive(id: string): boolean {
    return this.live.has(id)
  }

  /** The in-memory summary of a live run (fresher than `run.json`). */
  liveRun(id: string): RunSummary | null {
    return this.live.get(id)?.run ?? null
  }

  async start(params: StartRunParams, ctx: RunContext): Promise<RunSummary> {
    const now = new Date()
    const run: RunSummary = {
      id: newRunId(now),
      title: runTitle(params),
      params,
      agent: ctx.agent ?? DEFAULT_AGENT,
      status: 'running',
      sessionId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      outputFolder: null,
      outputFiles: [],
      costUsd: 0,
      live: true,
      ...(params.unattended ? { unattended: true as const } : {})
    }
    await saveRun(ctx.workspace, run)
    this.spawnFor(run, ctx, null, 0)
    const prompt = buildFirstPrompt(params)
    await this.send(run.id, prompt, adapterFor(run.agent).firstMessage(prompt, ctx.systemPrompt))
    return { ...run }
  }

  /**
   * Sends a reply. A live process gets it on stdin right away; otherwise the
   * session is resumed in a new process, and only then is `context` resolved.
   */
  async reply(id: string, text: string, context: () => Promise<RunContext>): Promise<RunSummary> {
    const live = this.live.get(id)
    if (live) {
      // An exec agent's process lives for one turn: while it runs, the turn is not over.
      if (live.adapter.turnMode === 'exec') throw stillWorking(live)
      await this.send(id, text)
      return { ...live.run }
    }
    return this.idle(id, async () => {
      let entry = this.live.get(id)
      if (entry) {
        // A reply that came first resumed the run meanwhile. An exec agent has already read its
        // whole prompt (stdin is closed), so this one could never reach it: refuse it.
        if (entry.adapter.turnMode === 'exec') throw stillWorking(entry)
      } else {
        const ctx = await context()
        const run = await readRun(ctx.workspace, id)
        if ((ctx.agent ?? DEFAULT_AGENT) !== run.agent)
          throw new Error(`This run uses ${AGENT_LABEL[run.agent]}; it cannot be continued with another agent.`)
        if (!run.sessionId) throw new Error(`This run has no ${AGENT_LABEL[run.agent]} session to resume.`)
        run.error = undefined
        const existing = (await readEvents(ctx.workspace, id)).length
        this.spawnFor(run, ctx, run.sessionId, existing)
        entry = this.live.get(id)!
      }
      await this.send(id, text)
      return { ...entry.run }
    })
  }

  stop(id: string): void {
    const entry = this.live.get(id)
    if (!entry) return
    entry.stopping = true
    this.kill(entry)
  }

  /**
   * Kills a run that Huntgry gave up on (the pipeline's stall watchdog): the run ends `failed`
   * with `reason`, not `stopped` (which the queue reads as cancelled), so it can be retried.
   */
  abort(id: string, reason: string): void {
    const entry = this.live.get(id)
    if (!entry) return
    entry.aborted = reason
    this.kill(entry)
  }

  private kill(entry: Live): void {
    entry.child.kill('SIGTERM')
    // Claude handles SIGTERM quickly; make sure nothing is left behind.
    setTimeout(() => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL')
    }, 3000).unref()
  }

  /**
   * Stops a run whatever its state: kills its process, or marks a run waiting with no
   * process (an exec agent between turns) stopped, so it does not look like it still waits.
   */
  stopAny(workspace: string, id: string): void {
    if (this.live.has(id)) return this.stop(id)
    this.endIdle(workspace, id, 'stopped').catch((err) => console.error('Stopping the run failed:', err))
  }

  /** Ends the conversation: closing stdin lets the agent finish and exit on its own. */
  finish(id: string): void {
    const entry = this.live.get(id)
    if (!entry) return
    entry.finishing = true
    entry.child.stdin.end()
  }

  /**
   * Ends a run that waits for the user with no process (an exec agent between
   * turns, or any run after a restart): `finished` when the user is done,
   * `stopped` when its queue job was cancelled. `null` when the run has a
   * process or is not waiting (nothing to do).
   */
  endIdle(workspace: string, id: string, status: 'finished' | 'stopped'): Promise<RunSummary | null> {
    return this.idle(id, async () => {
      if (this.live.has(id)) return null
      const run = await readRun(workspace, id)
      if (run.status !== 'waiting') return null
      if (status === 'stopped') {
        const seq = (await readEvents(workspace, id)).length
        const event = notice('info', 'Stopped.')
        await appendEvent(workspace, id, event)
        this.hooks.onEvent(id, seq, event)
      }
      const ended: RunSummary = { ...run, status, updatedAt: new Date().toISOString(), live: false }
      await saveRun(workspace, ended)
      this.hooks.onRun(ended)
      return ended
    })
  }

  /**
   * Runs `job` for a run with no process: after the previous resume/end of the same run, and
   * after its last process's writes are on disk, so it never reads or overwrites stale state.
   */
  private idle<T>(id: string, job: () => Promise<T>): Promise<T> {
    const previous = this.idleOps.get(id) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.settledById.get(id))
      .then(job)
    const tail = next.catch(() => undefined)
    this.idleOps.set(id, tail)
    void tail.then(() => {
      if (this.idleOps.get(id) === tail) this.idleOps.delete(id)
    })
    return next
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id)
  }

  /** Resolves when no process is left and every write is on disk (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.live.size > 0 || this.settling.size > 0 || this.idleOps.size > 0) {
      await Promise.all([...this.settling, ...this.idleOps.values(), ...[...this.live.values()].map((e) => e.queue)])
      if (this.live.size > 0) await new Promise((r) => setTimeout(r, 10))
    }
  }

  /** Resolves once every queued write of a live run is on disk (tests). */
  async flush(id: string): Promise<void> {
    await this.live.get(id)?.queue
  }

  private spawnFor(run: RunSummary, ctx: RunContext, resumeSessionId: string | null, seq: number): void {
    const adapter = adapterFor(run.agent)
    const args = [
      ...(ctx.commandPrefixArgs ?? []),
      ...adapter.args({
        skillDir: ctx.skillDir,
        resumeSessionId,
        systemPrompt: ctx.systemPrompt,
        sandbox: ctx.sandbox,
        model: ctx.model,
        permissionPrompts: ctx.permissionPrompts
      })
    ]
    // cwd is the workspace for every agent (Codex's `exec resume` has no -C and relies on it).
    const child = spawn(ctx.command, args, { cwd: ctx.workspace, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const entry: Live = {
      child,
      run: { ...run, live: true },
      ctx,
      adapter,
      stderr: '',
      queue: Promise.resolve(),
      seq,
      stopping: false,
      finishing: false,
      turnEnded: false,
      turnContent: 0,
      turnStartedAt: Date.now()
    }
    entry.run.lastOutputAt = new Date().toISOString()
    this.live.set(run.id, entry)

    const lines = new LineBuffer()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) this.handleLine(entry, line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      entry.stderr = (entry.stderr + chunk).slice(-STDERR_TAIL)
    })
    child.stdin.on('error', () => {
      // EPIPE when the process died first; the exit handler reports it.
    })
    child.on('error', (err) => {
      entry.stderr += `\n${err.message}`
    })
    child.on('close', (code, signal) => {
      for (const line of lines.flush()) this.handleLine(entry, line)
      this.live.delete(run.id)
      const r = entry.run
      r.live = false
      const { adapter } = entry
      const exec = adapter.turnMode === 'exec'
      if (entry.stopping) {
        r.status = 'stopped'
      } else if (entry.aborted) {
        r.status = 'failed'
        r.error = entry.aborted
      } else if (entry.finishing || (code === 0 && !exec && !entry.turnError)) {
        r.status = 'finished'
      } else if (!entry.turnEnded || entry.turnError) {
        // An exec agent that exits cleanly after its turn is between turns ("waiting"), not finished.
        r.status = 'failed'
        const stderr = entry.stderr.trim()
        const hint = adapter.explainFailure(stderr, entry.ctx.claudeVersion ?? null)
        const exited =
          code === 0 && exec ? `${adapter.binary} exited before the turn ended` : `${adapter.binary} exited with ${signal ?? `code ${code}`}`
        r.error = [...new Set([hint, entry.turnError, stderr || exited].filter(Boolean))].join('\n\n')
      }
      // A process that exits after its turn (status "waiting") can still be resumed: keep "waiting".
      if (r.status === 'failed' || r.status === 'stopped') {
        this.record(
          entry,
          notice(
            r.status === 'failed' ? 'error' : 'info',
            r.status === 'failed' ? `${adapter.label} stopped: ${r.error}` : 'Stopped.'
          )
        )
      }
      this.touch(entry)
      const settled = entry.queue.then(() => {
        this.settling.delete(settled)
        if (this.settledById.get(run.id) === settled) this.settledById.delete(run.id)
      })
      this.settling.add(settled)
      this.settledById.set(run.id, settled)
    })
  }

  /** Records the user's `text` and sends `sent` (the text, or the first message with context) to the agent. */
  private async send(id: string, text: string, sent = text): Promise<void> {
    const entry = this.live.get(id)
    if (!entry) throw new Error('This run is not active.')
    entry.run.status = 'running'
    entry.turnStartedAt = Date.now()
    entry.turnContent = 0
    entry.turnEnded = false
    const event: HuntgryEvent = { type: 'huntgry', subtype: 'user_message', text, ts: new Date().toISOString() }
    this.record(entry, event)
    this.touch(entry)
    entry.child.stdin.write(entry.adapter.userMessage(sent))
    // An exec agent reads its prompt until end of input.
    if (entry.adapter.turnMode === 'exec') entry.child.stdin.end()
  }

  private handleLine(entry: Live, line: string): void {
    const event = parseEventLine(line)
    if (!event) return
    const signal = entry.adapter.signal(event)
    const r = entry.run
    r.lastOutputAt = new Date().toISOString()
    if (signal.type === 'drop') return
    if (signal.type === 'rate-limit') {
      // Not recorded (nothing for the transcript); the pipeline reads it from the summary.
      r.rateLimit = {
        status: signal.status,
        ...(signal.resetsAt !== undefined ? { resetsAt: signal.resetsAt } : {}),
        ...(signal.rateLimitType ? { rateLimitType: signal.rateLimitType } : {}),
        ...(signal.utilization !== undefined ? { utilization: signal.utilization } : {})
      }
      this.touch(entry)
      return
    }
    this.record(entry, event)
    if (signal.type === 'keep' && signal.content) entry.turnContent++
    if (signal.type === 'init') {
      r.sessionId = signal.sessionId
      this.touch(entry)
    } else if (signal.type === 'turn-end') {
      if (signal.costUsd !== undefined) r.costUsd += signal.costUsd
      if (signal.usage) {
        r.usage = {
          inputTokens: (r.usage?.inputTokens ?? 0) + signal.usage.inputTokens,
          outputTokens: (r.usage?.outputTokens ?? 0) + signal.usage.outputTokens
        }
      }
      if (signal.sessionId) r.sessionId = signal.sessionId
      // A per-turn agent that exits after a turn with no output and nothing done would leave the
      // run waiting for a reply to nothing: fail it instead, so the user sees it and can retry.
      const empty =
        !signal.error &&
        entry.adapter.turnMode === 'exec' &&
        entry.turnContent === 0 &&
        signal.usage?.outputTokens === 0
      entry.turnError = signal.error ?? (empty ? `${entry.adapter.label} ended the turn without any answer or action.` : undefined)
      r.error = entry.turnError
      entry.turnEnded = true
      const since = entry.turnStartedAt - 1000
      entry.queue = entry.queue.then(async () => {
        // Other runs may be building at the same time: never take a folder another live run owns,
        // or one named after another live run's job id (it may not have recorded it yet).
        const others = [...this.live.values()].filter((e) => e !== entry)
        const { role, company, jobId } = r.params
        const out = await findOutputFolder(entry.ctx.workspace, since, {
          prefer: { role, company, jobId },
          exclude: others.map((e) => e.run.outputFolder).filter((f): f is string => !!f),
          claimedJobIds: others.map((e) => e.run.params.jobId).filter((id): id is string => !!id)
        }).catch(() => null)
        if (out) {
          r.outputFolder = out.folder
          r.outputFiles = out.files
          // Let the Dashboard link the application back to its posting and board.
          const { jobUrl, source } = r.params
          if (jobUrl) {
            await recordJobSource(join(entry.ctx.workspace, out.folder), jobUrl, source ?? 'manual').catch((err) =>
              console.error('Recording the job source failed:', err)
            )
          }
        }
        // Only now does the run read as waiting, so every summary that says so carries the output
        // folder (a summary queued earlier, e.g. for the session id, still reads as running).
        // The process may have ended meanwhile (failed, stopped, finished): that verdict stands.
        if (r.status === 'running') r.status = 'waiting'
      })
      this.touch(entry)
    }
  }

  /** Appends an event to `events.jsonl` (in order) and forwards it. */
  private record(entry: Live, event: unknown): void {
    const { workspace } = entry.ctx
    const id = entry.run.id
    const seq = entry.seq++
    entry.queue = entry.queue
      .then(() => appendEvent(workspace, id, event))
      .catch((err) => console.error('Run log write failed:', err))
    this.hooks.onEvent(id, seq, event)
  }

  /** Persists and broadcasts the run summary after pending writes. */
  private touch(entry: Live): void {
    entry.queue = entry.queue
      .then(async () => {
        entry.run.updatedAt = new Date().toISOString()
        await saveRun(entry.ctx.workspace, entry.run)
        this.hooks.onRun({ ...entry.run, live: this.live.has(entry.run.id) })
      })
      .catch((err) => console.error('Run save failed:', err))
  }
}

function stillWorking(entry: Live): Error {
  return new Error(`${entry.adapter.label} is still working on this turn; reply when it has answered.`)
}

function notice(level: 'info' | 'error', text: string): HuntgryEvent {
  return { type: 'huntgry', subtype: 'notice', level, text, ts: new Date().toISOString() }
}
