import type { PricingState, UsageFilter, UsageSummary } from './usage-types'

/**
 * Types for running the resume-tailor skill from the app through an agent CLI
 * (Claude Code, Codex, Antigravity): environment checks (Settings page) and
 * tailoring runs (Tailor page).
 */

/** Agent CLIs a run can use. The one list: validation, labels, adapters and the UI derive from it. */
export const AGENT_IDS = ['claude', 'codex', 'antigravity'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }

/** Used when nothing is chosen, and for runs recorded before agents could be chosen. */
export const DEFAULT_AGENT: AgentId = 'claude'

export function isAgentId(v: unknown): v is AgentId {
  return (AGENT_IDS as readonly unknown[]).includes(v)
}

/** One agent's CLI and skill, for Settings and the agent pickers. */
export interface AgentStatus {
  id: AgentId
  label: string
  /** Absolute path of the CLI, or `null` when not found. */
  cliPath: string | null
  /** `x.y.z`, or `null` when unknown. */
  version: string | null
  /** The resume-tailor folder this agent reads, or `null` when it cannot see the skill. */
  skillPath: string | null
  /** Where "Install skill" makes the skill visible to this agent. */
  skillTarget: string
  /** The CLI is found and sees the skill (shared dependencies are reported separately). */
  ready: boolean
  /** Why it is not ready, most important first. */
  problems: string[]
}

/** Input and output tokens only: the legacy `run.usage`, transcript footers and the remote protocol. */
export interface TokenCount {
  inputTokens: number
  outputTokens: number
}

/**
 * Tokens of one turn (or a sum of turns), normalized the same way for every agent (#44).
 * The four billed buckets do not overlap: input + cache reads + cache writes + output is
 * everything the model was charged for. Reasoning is a part of `outputTokens`.
 */
export interface TokenUsage extends TokenCount {
  /** Uncached input (cache reads and writes are not in it). */
  inputTokens: number
  /** Input read from the prompt cache. */
  cacheReadTokens: number
  /** Input written to the prompt cache (Claude, Codex). */
  cacheWriteTokens: number
  /** The part of `cacheWriteTokens` written to Claude's 1-hour cache (priced higher than the 5-minute one). */
  cacheWrite1hTokens?: number
  /** Every billed output token, reasoning included. */
  outputTokens: number
  /** Thinking / reasoning tokens: already counted in `outputTokens`, shown on their own. */
  reasoningTokens: number
}

/** One model's share of a turn (Claude reports it per model when sub-agents use another one). */
export interface ModelTurnUsage {
  model: string
  usage: TokenUsage
  /** What the CLI itself reported for this model (Claude `modelUsage[m].costUSD`). */
  reportedCostUsd?: number
}

/** What one turn of a run took: Huntgry-measured time, the model, normalized tokens and the price (#44). */
export interface TurnMetrics {
  /** 1-based: the n-th message the user (or Huntgry) sent in this run. */
  turn: number
  startedAt: string
  endedAt: string
  /** From sending the message to the turn's end (or the process's exit): the time the agent worked. */
  activeMs: number
  /** Claude's `duration_api_ms` / the CLI's own duration, kept as detail. */
  apiMs?: number
  /** Resolved model id, `null` = unknown. */
  model: string | null
  usage: TokenUsage
  /** Per model, when the CLI splits it (Claude with sub-agents on another model). */
  models?: ModelTurnUsage[]
  /** What the CLI itself reported for the turn (Claude). */
  reportedCostUsd?: number
  /** From the price table; `null` = a model of this turn is not priced (never 0 for "unknown"). */
  estimatedCostUsd: number | null
  /** The turn ended normally (not an error, a stop or a crash). */
  ok: boolean
}

/** Sums over a run's `metrics`, recomputed whenever a turn is added or prices change. */
export interface RunTotals {
  turns: number
  activeMs: number
  usage: TokenUsage
  /** Sum over the priced turns. */
  estimatedCostUsd: number
  pricedTurns: number
  /** Turns whose model has no price: `estimatedCostUsd` leaves them out. */
  unpricedTurns: number
  /** Sum of what the CLI reported (Claude), when it reported anything. */
  reportedCostUsd?: number
}

/**
 * The CLI's last session-wide counters (Claude's `total_cost_usd` and `modelUsage`, Codex's
 * `turn.completed.usage`): both CLIs report the session's running totals, so a turn's share is the
 * difference with the previous turn. Stored in `run.json` so a resumed run continues from it.
 */
export interface CliCounters {
  usage?: TokenUsage
  costUsd?: number
  models?: Record<string, { usage: TokenUsage; costUsd?: number }>
}

/** One dependency line from the skill's `scripts/preflight.py`, plus the app's own checks. */
export interface PreflightItem {
  name: string
  status: 'ok' | 'missing' | 'optional'
  detail: string
}

/** How the `claude` binary was installed (decides how it can be updated). */
export type ClaudeInstallKind = 'native' | 'homebrew' | 'npm' | 'other'

/** From `claude auth status`. */
export interface ClaudeAuth {
  loggedIn: boolean
  email?: string
  authMethod?: string
  subscriptionType?: string
}

/** Terminal commands the Settings page shows next to its buttons. */
export const CLAUDE_COMMANDS = {
  install: 'curl -fsSL https://claude.ai/install.sh | bash',
  login: 'claude auth login',
  brewUpgrade: 'brew upgrade claude-code'
} as const

export interface RunnerEnvironment {
  /** Absolute path of the `claude` binary, or `null` when not found. */
  claudePath: string | null
  /** `x.y.z`, or `null` when unknown (not found, or `claude --version` failed). */
  claudeVersion: string | null
  /** The version is known and at least `recommendedClaudeVersion`. */
  claudeVersionOk: boolean
  recommendedClaudeVersion: string
  claudeInstallKind: ClaudeInstallKind | null
  /** `null` when `claude auth status` could not tell (not found, too old, failed). */
  claudeAuth: ClaudeAuth | null
  /** The skill copy Huntgry installed from GitHub, when that is the one in use. */
  skillInstall: { tag: string; installedAt: string } | null
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
  /** Things worth fixing that do not block a run (e.g. an old Claude Code). */
  warnings: string[]
  /** The agent a new run uses unless the user picks another one. */
  defaultAgent: AgentId
  /** Every agent, in `AGENT_IDS` order. */
  agents: AgentStatus[]
  /** Problems of the dependencies every agent shares (venv, LaTeX, preflight); `problems` adds the default agent's. */
  sharedProblems: string[]
}

export interface InstallResult {
  ok: boolean
  error?: string
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
  /** Where the job was found (`hiring.cafe`, `indeed`, `url`, `pasted`); `manual` when typed on the Tailor page. */
  source?: JobSourceTag
  /** Agent to run with; the default agent from Settings when absent. */
  agent?: AgentId
  /** Unattended run (#31): the unattended system prompt, auto-finished, result Unreviewed. */
  unattended?: true
  /** The bulk request ("Tailor all", a pipeline) this run belongs to: its queue items share it (#44). */
  batchId?: string
}

/** Recorded with the application in `huntgry.json`, so the Dashboard can show where a job came from. */
export const JOB_SOURCE_TAGS = ['hiring.cafe', 'indeed', 'url', 'pasted', 'manual'] as const
export type JobSourceTag = (typeof JOB_SOURCE_TAGS)[number]

export type RunStatus =
  /** Process spawned, first turn in progress. */
  | 'running'
  /** The agent finished its turn and waits for the user's reply (e.g. the approval step). */
  | 'waiting'
  /** User ended the run, or the process exited normally. */
  | 'finished'
  | 'failed'
  | 'stopped'

export interface RunSummary {
  id: string
  title: string
  params: StartRunParams
  /** Agent the run uses (replies too). Runs recorded before agents could be chosen read as `claude`. */
  agent: AgentId
  status: RunStatus
  /** The agent's session (Claude), thread (Codex) or conversation (Antigravity) id, used to resume. */
  sessionId: string | null
  createdAt: string
  updatedAt: string
  /** Application folder the skill wrote (`<role>/<company>/<job-id>`), relative to the workspace. */
  outputFolder: string | null
  /** Files found in the output folder, e.g. `resume.pdf`. */
  outputFiles: string[]
  /** What the CLI reported (Claude only): the sum of the per-turn `reportedCostUsd`. */
  costUsd: number
  /** Tokens used so far (legacy: input incl. cache, output), for agents that report tokens instead of a price. */
  usage?: TokenCount
  /** The model of the last turn (or the one Huntgry expects before the first turn ends), `null` = unknown (#44). */
  model?: string | null
  /** One entry per turn, in order (#44). Absent on runs recorded before metrics (until backfilled). */
  metrics?: TurnMetrics[]
  /** Sums of `metrics`. */
  totals?: RunTotals
  /** See `CliCounters`. */
  cliCounters?: CliCounters
  /** `metrics` were rebuilt from `events.jsonl` (active time is approximate). */
  backfilled?: true
  /** The process is alive (a reply can be sent without resuming). */
  live: boolean
  error?: string
  /** Started by the unattended pipeline (#31): replies and re-runs keep the unattended prompt. */
  unattended?: true
  /** Claude's latest `rate_limit_event` (absent for other agents and API-key sessions). */
  rateLimit?: RunRateLimit
  /** ISO time of the last stdout line of the current process; the pipeline's stall watchdog reads it. */
  lastOutputAt?: string
}

/** From Claude Code's `rate_limit_event` → `rate_limit_info`. */
export interface RunRateLimit {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** Unix epoch seconds when the window resets. */
  resetsAt?: number
  rateLimitType?: string
  /** 0–1 of the window used. */
  utilization?: number
}

/** A rendered piece of the conversation, derived from the raw stream-json events. */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; output?: string }
  | {
      kind: 'result'
      id: string
      ok: boolean
      text: string
      costUsd: number
      durationMs: number
      denials: string[]
      /** Set for agents that report tokens instead of a price. */
      usage?: TokenCount
      /** 1-based turn this result ends (the number of user messages before it): the key into `run.metrics`. */
      turn?: number
    }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string }

export interface RunDetail {
  run: RunSummary
  /** Raw events as stored in `events.jsonl`; the renderer folds them with `buildTranscript`. */
  events: unknown[]
}

export interface RunnerApi {
  /** Locate the agent CLIs + skill, check dependencies. */
  environment(): Promise<RunnerEnvironment>
  /** Saves the agent new runs use by default. */
  setDefaultAgent(agent: AgentId): Promise<void>
  /** Makes the installed resume-tailor skill visible to `agent` (a link to the Claude copy, or a copy). */
  linkSkill(agent: AgentId): Promise<InstallResult & { path?: string }>
  /** (Re)create the Python venv and install the skill's modules; progress arrives as `runner:install-log`. */
  installPythonDeps(): Promise<InstallResult>
  /** Run the official Claude Code installer (`claude.ai/install.sh`); progress on `runner:install-log`. */
  installClaude(): Promise<InstallResult>
  /** `claude update` (native/npm); for Homebrew the error carries the command to run. */
  updateClaude(): Promise<InstallResult>
  /** Download the resume-tailor skill from its latest GitHub release into ~/.claude/skills. `replace` = Reinstall. */
  installSkill(replace?: boolean): Promise<InstallResult & { tag?: string }>
  listRuns(): Promise<RunSummary[]>
  getRun(id: string): Promise<RunDetail>
  start(params: StartRunParams): Promise<RunSummary>
  /** Send the user's reply. Resumes the agent's session if the process is gone. */
  reply(id: string, text: string): Promise<RunSummary>
  /** Kill the process now. */
  stop(id: string): Promise<RunSummary>
  /** Close the conversation cleanly (the user is done); also ends a waiting run with no process. */
  finish(id: string): Promise<RunSummary>
  /** Open a file of the run's output folder (`resume.pdf`, `cover.pdf`, …) with the OS. */
  openOutput(id: string, file: string): Promise<void>
  revealOutput(id: string): Promise<void>
  /** Totals across the workspace's runs for the Dashboard (#44). */
  usageSummary(filter?: UsageFilter): Promise<UsageSummary>
  /** Saves the filtered per-run numbers as CSV (asks where); `null` when cancelled. */
  exportUsage(filter?: UsageFilter): Promise<{ path: string } | null>
  /** Settings → Pricing. */
  prices(): Promise<PricingState>
  /** Adds or replaces the price of one model (`ModelPrice` without `custom`). */
  setPrice(price: unknown): Promise<PricingState>
  /** Drops the user's price for a model (a bundled one goes back to its bundled price). */
  removePrice(id: string): Promise<PricingState>
  resetPrices(): Promise<PricingState>
}

export const RUNNER_CHANNELS = {
  environment: 'runner:environment',
  setDefaultAgent: 'runner:set-default-agent',
  linkSkill: 'runner:link-skill',
  installPythonDeps: 'runner:install-python-deps',
  installClaude: 'runner:install-claude',
  updateClaude: 'runner:update-claude',
  installSkill: 'runner:install-skill',
  listRuns: 'runner:list-runs',
  getRun: 'runner:get-run',
  start: 'runner:start',
  reply: 'runner:reply',
  stop: 'runner:stop',
  finish: 'runner:finish',
  openOutput: 'runner:open-output',
  revealOutput: 'runner:reveal-output',
  usageSummary: 'runner:usage-summary',
  exportUsage: 'runner:export-usage',
  prices: 'runner:prices',
  setPrice: 'runner:set-price',
  removePrice: 'runner:remove-price',
  resetPrices: 'runner:reset-prices'
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
  /** Settings → Pricing changed: estimates shown anywhere are stale. */
  'runner:prices': PricingState
  /** A line of installer output (Python dependencies, Claude Code, the skill). */
  'runner:install-log': string
}
