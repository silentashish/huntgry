import { join } from 'node:path'
import { buildClaudeArgs, userMessageLine } from '../command'
import { explainClaudeError } from '../version'
import type { AgentAdapter } from './types'

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
    // Hook chatter and rate-limit pings carry nothing for the user.
    if (event.type === 'rate_limit_event' || (event.type === 'system' && event.subtype !== 'init')) return { type: 'drop' }
    if (event.type === 'system' && typeof event.session_id === 'string') return { type: 'init', sessionId: event.session_id }
    if (event.type === 'result') {
      return {
        type: 'turn-end',
        sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined
      }
    }
    return { type: 'keep' }
  },
  explainFailure: explainClaudeError
}
