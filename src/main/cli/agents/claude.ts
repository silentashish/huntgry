import { join } from 'node:path'
import { buildClaudeArgs, userMessageLine } from '../command'
import { explainClaudeError } from '../version'
import type { TokenUsage } from '@shared/runner-types'
import { isObj, num, usageOf, type AgentAdapter, type Json, type PartialUsage, type TurnEndSignal } from './types'

/**
 * Claude Code: `claude -p` in stream-json mode, one process kept alive between
 * turns. The command line is `buildClaudeArgs` (allowlist + OS sandbox), unchanged.
 */
export const claude: AgentAdapter = {
  id: 'claude',
  label: 'Claude',
  binary: 'claude',
  turnMode: 'stream',
  skillRoots: (home) => [join(home, '.claude/skills')],
  args: (inv) =>
    buildClaudeArgs({
      skillDir: inv.skillDir,
      resumeSessionId: inv.resumeSessionId,
      systemPrompt: inv.systemPrompt,
      sandbox: inv.sandbox,
      model: inv.model,
      permissionPrompts: inv.permissionPrompts
    }),
  // `--append-system-prompt` carries the context.
  firstMessage: (prompt) => prompt,
  userMessage: userMessageLine,
  signal(event) {
    // Rate-limit pings carry nothing for the user, but the unattended pipeline reads the reset time.
    if (event.type === 'rate_limit_event') {
      const info = isObj(event.rate_limit_info) ? event.rate_limit_info : {}
      const status = info.status
      if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return { type: 'drop' }
      return {
        type: 'rate-limit',
        status,
        resetsAt: typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : undefined,
        rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
        utilization: typeof info.utilization === 'number' ? info.utilization : undefined
      }
    }
    // Hook chatter carries nothing for the user.
    if (event.type === 'system' && event.subtype !== 'init') return { type: 'drop' }
    if (event.type === 'system' && typeof event.session_id === 'string')
      return {
        type: 'init',
        sessionId: event.session_id,
        ...(typeof event.model === 'string' && event.model ? { model: event.model } : {})
      }
    if (event.type === 'result') {
      // A failed turn (usage limit, max turns, …) carries its reason in `result`; the process exits afterwards.
      const failed = event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))
      const text = typeof event.result === 'string' && event.result.trim() ? event.result.trim() : undefined
      return {
        type: 'turn-end',
        sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
        ...claudeUsage(event),
        error: failed ? (text ?? `Claude ended the turn with ${String(event.subtype ?? 'an error')}`) : undefined
      }
    }
    const partial = claudePartialUsage(event)
    return partial ? { type: 'keep', partial } : { type: 'keep' }
  },
  explainFailure: explainClaudeError
}

/**
 * A `result` event's tokens (#44). `usage` is the turn's own, already split into uncached input,
 * cache reads and cache writes (the 1-hour part under `cache_creation`); thinking is part of
 * `output_tokens`. `modelUsage` and `total_cost_usd` are the session's running totals.
 */
export function claudeUsage(event: Json): Pick<TurnEndSignal, 'usage' | 'usageScope' | 'models' | 'apiMs' | 'durationMs'> {
  const out: Pick<TurnEndSignal, 'usage' | 'usageScope' | 'models' | 'apiMs' | 'durationMs'> = {}
  if (isObj(event.usage)) {
    const u = event.usage
    const details = isObj(u.output_tokens_details) ? u.output_tokens_details : {}
    const creation = isObj(u.cache_creation) ? u.cache_creation : {}
    out.usage = usageOf({
      inputTokens: num(u.input_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      cacheWrite1hTokens: num(creation.ephemeral_1h_input_tokens),
      outputTokens: num(u.output_tokens),
      reasoningTokens: num(details.thinking_tokens)
    })
    out.usageScope = 'turn'
  }
  if (isObj(event.modelUsage)) {
    const models: Record<string, { usage: TokenUsage; costUsd?: number }> = {}
    for (const [model, m] of Object.entries(event.modelUsage)) {
      if (!isObj(m) || !model) continue
      models[model] = {
        usage: usageOf({
          inputTokens: num(m.inputTokens),
          cacheReadTokens: num(m.cacheReadInputTokens),
          cacheWriteTokens: num(m.cacheCreationInputTokens),
          outputTokens: num(m.outputTokens),
          reasoningTokens: num(m.thinkingTokens)
        }),
        ...(typeof m.costUSD === 'number' && Number.isFinite(m.costUSD) ? { costUsd: m.costUSD } : {})
      }
    }
    if (Object.keys(models).length > 0) out.models = models
  }
  if (num(event.duration_api_ms) > 0) out.apiMs = num(event.duration_api_ms)
  if (num(event.duration_ms) > 0) out.durationMs = num(event.duration_ms)
  return out
}

/**
 * The usage of one API request, as an `assistant` event carries it (sub-agents' too: they are billed).
 * Its `output_tokens` is only what was streamed so far, so a turn built from these is incomplete.
 */
export function claudePartialUsage(event: Json): PartialUsage | undefined {
  if (event.type !== 'assistant' || !isObj(event.message) || !isObj(event.message.usage)) return undefined
  const m = event.message
  const u = m.usage as Json
  if (typeof m.id !== 'string' || !m.id) return undefined
  const creation = isObj(u.cache_creation) ? u.cache_creation : {}
  return {
    key: m.id,
    ...(typeof m.model === 'string' && m.model ? { model: m.model } : {}),
    usage: usageOf({
      inputTokens: num(u.input_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      cacheWrite1hTokens: num(creation.ephemeral_1h_input_tokens),
      outputTokens: num(u.output_tokens)
    })
  }
}
