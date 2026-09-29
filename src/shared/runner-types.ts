/**
 * Types for running the resume-tailor Claude skill from the app: environment
 * checks (Settings page) and tailoring runs (Tailor page).
 */

/** One dependency line from the skill's `scripts/preflight.py`, plus the app's own checks. */
export interface PreflightItem {
  name: string
  status: 'ok' | 'missing' | 'optional'
  detail: string
}

export interface RunnerEnvironment {
  /** Absolute path of the `claude` binary, or `null` when not found. */
  claudePath: string | null
  claudeVersion: string | null
  /** Folder holding the installed resume-tailor `SKILL.md`, or `null`. */
  skillDir: string | null
  /** Python venv the app puts first on the skill's PATH. */
  venvDir: string
  venvReady: boolean
  /** TeX bin folder found (TinyTeX, MacTeX/BasicTeX), or `null`. */
  texBin: string | null
  preflight: PreflightItem[]
  /** Raw preflight output, shown when something is missing. */
  preflightOutput: string
  /** Everything needed for a full run (PDF build) is present. */
  ready: boolean
  /** Human-readable problems that block a run, in order of importance. */
  problems: string[]
}

export type DateStyle = 'inline' | 'right'

/** What the user fills in on the Tailor page. The renderer never sends paths or commands. */
export interface StartRunParams {
  /** Pasted job description (Markdown or plain text). One of this or `jobUrl` is required. */
  jobDescription?: string
  jobUrl?: string
  company?: string
  role?: string
  jobId?: string
  coverLetter: boolean
  dateStyle: DateStyle
  /** Anything else the user wants the skill to know (angle, seniority, stack). */
  notes?: string
}

export type RunStatus =
  /** Process spawned, first turn in progress. */
  | 'running'
  /** Claude finished its turn and waits for the user's reply (e.g. the approval step). */
  | 'waiting'
  /** User ended the run, or the process exited normally. */
  | 'finished'
  | 'failed'
  | 'stopped'

export interface RunSummary {
  id: string
  title: string
  params: StartRunParams
  status: RunStatus
  /** Claude session id, used to resume the conversation after a restart. */
  sessionId: string | null
  createdAt: string
  updatedAt: string
  /** Application folder the skill wrote (`<role>/<company>/<job-id>`), relative to the workspace. */
  outputFolder: string | null
  /** Files found in the output folder, e.g. `resume.pdf`. */
  outputFiles: string[]
  costUsd: number
  /** The process is alive (a reply can be sent without resuming). */
  live: boolean
  error?: string
}

/** A rendered piece of the conversation, derived from the raw stream-json events. */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; output?: string }
  | { kind: 'result'; id: string; ok: boolean; text: string; costUsd: number; durationMs: number; denials: string[] }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string }

export interface RunDetail {
  run: RunSummary
  /** Raw events as stored in `events.jsonl`; the renderer folds them with `buildTranscript`. */
  events: unknown[]
}

export interface RunnerApi {
  /** Locate claude + skill, check dependencies. */
  environment(): Promise<RunnerEnvironment>
  /** (Re)create the Python venv and install the skill's modules; progress arrives as `runner:install-log`. */
  installPythonDeps(): Promise<{ ok: boolean; error?: string }>
  listRuns(): Promise<RunSummary[]>
  getRun(id: string): Promise<RunDetail>
  start(params: StartRunParams): Promise<RunSummary>
  /** Send the user's reply. Resumes the Claude session if the process is gone. */
  reply(id: string, text: string): Promise<RunSummary>
  /** Kill the process now. */
  stop(id: string): Promise<RunSummary>
  /** Close the conversation cleanly (the user is done). */
  finish(id: string): Promise<RunSummary>
  /** Open a file of the run's output folder (`resume.pdf`, `cover.pdf`, …) with the OS. */
  openOutput(id: string, file: string): Promise<void>
  revealOutput(id: string): Promise<void>
}

export const RUNNER_CHANNELS = {
  environment: 'runner:environment',
  installPythonDeps: 'runner:install-python-deps',
  listRuns: 'runner:list-runs',
  getRun: 'runner:get-run',
  start: 'runner:start',
  reply: 'runner:reply',
  stop: 'runner:stop',
  finish: 'runner:finish',
  openOutput: 'runner:open-output',
  revealOutput: 'runner:reveal-output'
} as const

/** Payloads of the runner's main → renderer events. */
export interface RunnerEvents {
  /**
   * One raw stream-json event (or a Huntgry-recorded one) of a run. `seq` is
   * its index in `events.jsonl`, so a renderer that loaded the file can tell
   * which live events it already has.
   */
  'runner:event': { runId: string; seq: number; event: unknown }
  /** The run's summary changed (status, session id, output folder, cost). */
  'runner:run': RunSummary
  /** A line of `pip`/`venv` output while installing Python dependencies. */
  'runner:install-log': string
}
