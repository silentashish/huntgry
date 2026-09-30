import { AGENT_IDS, DEFAULT_AGENT, isAgentId, type AgentId } from '@shared/runner-types'
import { antigravity } from './antigravity'
import { claude } from './claude'
import { codex } from './codex'
import type { AgentAdapter } from './types'

/** Adding an agent: one adapter file, its id in `AGENT_IDS`, and an entry here. */
export const AGENTS: Record<AgentId, AgentAdapter> = { claude, codex, antigravity }

export function adapterFor(id: AgentId): AgentAdapter {
  return AGENTS[id]
}

/** Every adapter, in `AGENT_IDS` order. */
export const allAdapters = (): AgentAdapter[] => AGENT_IDS.map((id) => AGENTS[id])

/** A stored or received agent id; anything else is the default agent. */
export function agentOr(v: unknown, fallback: AgentId = DEFAULT_AGENT): AgentId {
  return isAgentId(v) ? v : fallback
}

export type { AgentAdapter, AgentInvocation, AgentSignal } from './types'
