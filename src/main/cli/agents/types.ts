import type { AgentId, TokenUsage } from '@shared/runner-types'
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
  /** Stored for the transcript. `content`: something the user sees (a message, a command, an edit). */
  | { type: 'keep'; content?: boolean }
  /** The session id to resume with is known. */
  | { type: 'init'; sessionId: string }
  /** The turn ended: the agent waits for the user. `error` = the turn failed. */
  | { type: 'turn-end'; sessionId?: string; costUsd?: number; usage?: TokenUsage; error?: string }

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
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
