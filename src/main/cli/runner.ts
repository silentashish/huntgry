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
  /** Why the last turn failed, as the agent reported it (cleared by a good turn). */
  turnError?: string
  /** Serializes disk writes of this run so events keep their order. */
  queue: Promise<void>
  /** Index the next recorded event gets in `events.jsonl`. */
  seq: number
  stopping: boolean
  finishing: boolean
  turnStartedAt: number
}

const STDERR_TAIL = 4000

export class RunManager {
  private live = new Map<string, Live>()
  /** Writes still pending for runs whose process has exited. */
  private settling = new Set<Promise<void>>()

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
      live: true
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
    let entry = this.live.get(id)
    // An exec agent's process lives for one turn: while it runs, the turn is not over.
    if (entry && entry.adapter.turnMode === 'exec')
      throw new Error(`${entry.adapter.label} is still working on this turn; reply when it has answered.`)
    if (!entry) {
      const ctx = await context()
      const run = await readRun(ctx.workspace, id)
      if ((ctx.agent ?? DEFAULT_AGENT) !== run.agent)
        throw new Error(`This run uses ${AGENT_LABEL[run.agent]}; it cannot be continued with another agent.`)
      if (!run.sessionId) throw new Error(`This run has no ${AGENT_LABEL[run.agent]} session to resume.`)
      run.error = undefined
      const existing = (await readEvents(ctx.workspace, id)).length
      // Another reply may have resumed it while we were reading.
      if (!this.live.has(id)) this.spawnFor(run, ctx, run.sessionId, existing)
      entry = this.live.get(id)!
    }
    await this.send(id, text)
    return { ...entry.run }
  }

  stop(id: string): void {
    const entry = this.live.get(id)
    if (!entry) return
    entry.stopping = true
    entry.child.kill('SIGTERM')
    // Claude handles SIGTERM quickly; make sure nothing is left behind.
    setTimeout(() => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL')
    }, 3000).unref()
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
   * turns, or any run after a restart): it is marked finished. `null` when the
   * run is live or not waiting (nothing to do).
   */
  async finishIdle(workspace: string, id: string): Promise<RunSummary | null> {
    if (this.live.has(id)) return null
    const run = await readRun(workspace, id)
    if (run.status !== 'waiting') return null
    const done: RunSummary = { ...run, status: 'finished', updatedAt: new Date().toISOString(), live: false }
    await saveRun(workspace, done)
    this.hooks.onRun(done)
    return done
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id)
  }

  /** Resolves when no process is left and every write is on disk (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.live.size > 0 || this.settling.size > 0) {
      await Promise.all([...this.settling, ...[...this.live.values()].map((e) => e.queue)])
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
      turnStartedAt: Date.now()
    }
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
      } else if (entry.finishing || (code === 0 && !exec && !entry.turnError)) {
        r.status = 'finished'
      } else if (r.status !== 'waiting' || entry.turnError) {
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
      })
      this.settling.add(settled)
    })
  }

  /** Records the user's `text` and sends `sent` (the text, or the first message with context) to the agent. */
  private async send(id: string, text: string, sent = text): Promise<void> {
    const entry = this.live.get(id)
    if (!entry) throw new Error('This run is not active.')
    entry.run.status = 'running'
    entry.turnStartedAt = Date.now()
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
    if (signal.type === 'drop') return
    this.record(entry, event)
    const r = entry.run
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
      entry.turnError = signal.error
      r.error = signal.error
      r.status = 'waiting'
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

function notice(level: 'info' | 'error', text: string): HuntgryEvent {
  return { type: 'huntgry', subtype: 'notice', level, text, ts: new Date().toISOString() }
}
