import { JOB_ID_PATTERN } from '@shared/jobs-types'
import {
  DEFAULT_STALL_MINUTES,
  MAX_BUDGET_USD,
  MAX_STALL_MINUTES,
  MIN_STALL_MINUTES,
  type PipelineBudget,
  type PipelineStartInput
} from '@shared/pipeline-types'
import { DEFAULT_CONCURRENCY, MAX_ENQUEUE } from '@shared/queue-types'
import { DEFAULT_AGENT, isAgentId, type AgentId } from '@shared/runner-types'
import { requireEnqueueInput } from '../queue/queue'

/**
 * Validators shared by `pipeline/ipc.ts` and #41's gateway. The pipeline
 * itself is the `Pipeline` class in `pipeline.ts`; the app's instance lives in
 * `pipeline/ipc.ts`.
 */

export function requireBudget(v: unknown): PipelineBudget | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object') throw new Error('Invalid budget.')
  const b = v as Record<string, unknown>
  const out: PipelineBudget = {}
  if (b.maxCostUsd !== undefined && b.maxCostUsd !== null) {
    if (typeof b.maxCostUsd !== 'number' || !Number.isFinite(b.maxCostUsd) || b.maxCostUsd < 1 || b.maxCostUsd > MAX_BUDGET_USD)
      throw new Error(`The cost cap must be between $1 and $${MAX_BUDGET_USD}.`)
    out.maxCostUsd = Math.round(b.maxCostUsd * 100) / 100
  }
  if (b.maxJobs !== undefined && b.maxJobs !== null) {
    if (typeof b.maxJobs !== 'number' || !Number.isInteger(b.maxJobs) || b.maxJobs < 1 || b.maxJobs > MAX_ENQUEUE)
      throw new Error(`The job cap must be a whole number from 1 to ${MAX_ENQUEUE}.`)
    out.maxJobs = b.maxJobs
  }
  return out.maxCostUsd === undefined && out.maxJobs === undefined ? undefined : out
}

export function requireStallMinutes(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_STALL_MINUTES
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_STALL_MINUTES || v > MAX_STALL_MINUTES)
    throw new Error(`The stall threshold must be a whole number of minutes from ${MIN_STALL_MINUTES} to ${MAX_STALL_MINUTES}.`)
  return v
}

/** Checks what the renderer (or the phone) sends to plan or start a pipeline. */
export function requirePipelineStartInput(
  input: unknown,
  defaultAgent: AgentId = DEFAULT_AGENT
): Required<Omit<PipelineStartInput, 'fallbackAgent' | 'budget'>> & { fallbackAgent?: AgentId; budget?: PipelineBudget } {
  const base = requireEnqueueInput(input, defaultAgent)
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  let fallbackAgent: AgentId | undefined
  if (p.fallbackAgent !== undefined && p.fallbackAgent !== null) {
    if (!isAgentId(p.fallbackAgent)) throw new Error('Unknown fallback agent.')
    if (p.fallbackAgent === base.agent) throw new Error('The fallback agent must differ from the agent.')
    fallbackAgent = p.fallbackAgent
  }
  for (const key of ['resumeAfterRestart', 'skipTailored'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error(`Invalid ${key}.`)
  }
  if (!Array.isArray(p.jobIds) || p.jobIds.some((id) => typeof id !== 'string' || !JOB_ID_PATTERN.test(id)))
    throw new Error('Invalid job id.')
  return {
    jobIds: base.jobIds,
    options: base.options,
    agent: base.agent,
    concurrency: base.concurrency ?? DEFAULT_CONCURRENCY,
    ...(fallbackAgent ? { fallbackAgent } : {}),
    ...(requireBudget(p.budget) ? { budget: requireBudget(p.budget) } : {}),
    resumeAfterRestart: p.resumeAfterRestart !== false,
    skipTailored: p.skipTailored !== false,
    stallMinutes: requireStallMinutes(p.stallMinutes)
  }
}

export function requireResumeOptions(v: unknown): { budget?: PipelineBudget } {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object') throw new Error('Invalid options.')
  const budget = requireBudget((v as Record<string, unknown>).budget)
  return budget ? { budget } : {}
}
