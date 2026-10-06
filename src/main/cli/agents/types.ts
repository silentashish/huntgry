import type { AgentId, RunRateLimit, TokenUsage } from '@shared/runner-types'
import { ZERO_USAGE } from '@shared/pricing'
import type { SandboxPaths } from '../command'

/**
 * What differs between agent CLIs (Claude Code, Codex, Antigravity), so the
 * `RunManager` can drive any of them: the command line, how a user turn goes
 * in, what an output line means, and where the agent looks for skills. Main
 * builds every path and flag; the renderer only names the agent.
 */

export type Json = Record<string, unknown>

/** One spawn of the agent: a fresh run or a resumed session. */
export interface AgentInvocation {
  skillDir: string
  systemPrompt: string
  sandbox: SandboxPaths
  model?: string
  /** Continue this session / thread / conversation. */
  resumeSessionId?: string | null
  /** Claude Code ≥ 2.1.259 only: pass `--permission-prompts none`. */
  permissionPrompts?: boolean
}

/** What one stdout line means to the `RunManager`. */
export type AgentSignal =
  /** Not shown or stored (hook chatter, rate-limit pings). */
  | { type: 'drop' }
  /**
   * Stored for the transcript. `content`: something the user sees (a message, a command, an edit).
   * `partial`: usage of one API request seen before the turn ends (Claude's `assistant.message.usage`,
   * repeated for every block of the same message: `key` dedupes it). Only used when the turn never
   * ends (stop, crash), since the turn-end figures are the complete ones.
   */
  | { type: 'keep'; content?: boolean; partial?: PartialUsage }
  /** The session id to resume with is known (and the model, when the CLI says). */
  | { type: 'init'; sessionId: string; model?: string }
  /** The turn ended: the agent waits for the user. `error` = the turn failed. */
  | TurnEndSignal
  /** Claude's `rate_limit_event`: stored on the run (not shown), read by the unattended pipeline. */
  | { type: 'rate-limit'; status: RunRateLimit['status']; resetsAt?: number; rateLimitType?: string; utilization?: number }

export interface PartialUsage {
  key: string
  model?: string
  usage: TokenUsage
}

/**
 * The end of a turn, with what the CLI reported about it, normalized to `TokenUsage` (#44).
 * Some counters are the session's running totals, not the turn's: the `RunManager` takes the
 * difference with the previous turn (see `metrics.ts`).
 */
export interface TurnEndSignal {
  type: 'turn-end'
  sessionId?: string
  /** Claude's `total_cost_usd`: the session's cost so far (not the turn's). */
  costUsd?: number
  usage?: TokenUsage
  /** `usage` is the turn's own (`turn`, the default) or the session's running total (`session`, Codex). */
  usageScope?: 'turn' | 'session'
  /** Per model, the session's running totals (Claude `modelUsage`). */
  models?: Record<string, { usage: TokenUsage; costUsd?: number }>
  /** The model the CLI says it ran, when it says so. */
  model?: string
  /** Claude's `duration_api_ms`: time spent in API calls. */
  apiMs?: number
  /** The CLI's own wall time of the turn (Claude `duration_ms`, agy `duration_seconds`); the backfill's active time. */
  durationMs?: number
  error?: string
}

export interface AgentAdapter {
  id: AgentId
  label: string
  /** Executable name looked up on PATH. */
  binary: string
  /**
   * `stream`: one process for the whole conversation, one stdin line per turn
   * (claude, agy). `exec`: one process per turn, prompt on stdin, then stdin
   * is closed; replies resume the thread in a new process (codex).
   */
  turnMode: 'stream' | 'exec'
  /** Folders the agent loads personal skills from, first = where Huntgry installs. Only direct children count. */
  skillRoots(home: string): string[]
  args(inv: AgentInvocation): string[]
  /** The first message as sent: agents with no system-prompt flag get Huntgry's context here. */
  firstMessage(prompt: string, systemPrompt: string): string
  /** One user turn, encoded for stdin. */
  userMessage(text: string): string
  signal(event: Json): AgentSignal
  /** A readable reason for a failed process from its stderr tail, or `null` when there is nothing to add. */
  explainFailure(stderr: string, version: string | null): string | null
}

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** A `TokenUsage` with the given counts (the rest zero). */
export function usageOf(parts: Partial<TokenUsage>): TokenUsage {
  const u: TokenUsage = { ...ZERO_USAGE, ...parts }
  if (!u.cacheWrite1hTokens) delete u.cacheWrite1hTokens
  return u
}
