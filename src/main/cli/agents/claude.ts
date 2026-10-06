import { join } from 'node:path'
import { buildClaudeArgs, userMessageLine } from '../command'
import { explainClaudeError } from '../version'
import { isObj, type AgentAdapter } from './types'

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
    if (event.type === 'system' && typeof event.session_id === 'string') return { type: 'init', sessionId: event.session_id }
    if (event.type === 'result') {
      // A failed turn (usage limit, max turns, …) carries its reason in `result`; the process exits afterwards.
      const failed = event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))
      const text = typeof event.result === 'string' && event.result.trim() ? event.result.trim() : undefined
      return {
        type: 'turn-end',
        sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
        error: failed ? (text ?? `Claude ended the turn with ${String(event.subtype ?? 'an error')}`) : undefined
      }
    }
    return { type: 'keep' }
  },
  explainFailure: explainClaudeError
}
