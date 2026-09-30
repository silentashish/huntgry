import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isObj, num, type AgentAdapter, type AgentInvocation } from './types'

/**
 * OpenAI Codex CLI: `codex exec --json`, one process per turn (exec has no
 * stdin streaming). The prompt goes in on stdin and stdin is closed; a reply
 * is `codex exec resume <thread_id>` in a new process.
 *
 * Isolation, as close to the Claude setup as Codex allows:
 * - `workspace-write` sandbox: writes only in the workspace (and temp), no
 *   network (`network_access=false`), web search off.
 * - `approval_policy="never"`: exec never prompts; refused commands come back
 *   to the model, like Claude's `--permission-prompts none`.
 * - `--ignore-user-config` / `--ignore-rules`: the user's config.toml (MCP
 *   servers, plugins, hooks, rules) must not widen what a headless run may do.
 *   Sign-in is kept.
 * Gaps: no per-command allowlist (any command inside the sandbox) and reads
 * are not restricted. Documented in docs/changes/22-multi-agent.md.
 */

/** Config overrides both `exec` and `exec resume` get (`-c key=<TOML value>`). */
function overrides(inv: AgentInvocation): string[] {
  const pairs = [
    'approval_policy="never"',
    'sandbox_workspace_write.network_access=false',
    'web_search="disabled"',
    // The venv, TeX and CV_HOME reach the skill's scripts through the environment Huntgry builds.
    'shell_environment_policy.inherit="all"',
    // A JSON string is a valid TOML basic string.
    `developer_instructions=${JSON.stringify(inv.systemPrompt)}`
  ]
  return pairs.flatMap((p) => ['-c', p])
}

const COMMON = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']

export function buildCodexArgs(inv: AgentInvocation): string[] {
  const model = inv.model ? ['-m', inv.model] : []
  if (inv.resumeSessionId) {
    // `resume` takes no -C or -s: the process runs in the workspace (cwd) and the sandbox is set by config.
    return [
      'exec',
      'resume',
      inv.resumeSessionId,
      ...COMMON,
      '-c',
      'sandbox_mode="workspace-write"',
      ...overrides(inv),
      ...model,
      '-'
    ]
  }
  // No --ephemeral: the thread must be on disk to resume it.
  return ['exec', ...COMMON, '-C', inv.sandbox.workspace, '-s', 'workspace-write', ...overrides(inv), ...model, '-']
}

/** `model = "…"` from ~/.codex/config.toml (runs ignore that file, so it is passed with -m). */
export async function codexModel(home: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
    // Top-level keys only: stop at the first [table].
    const top = text.split(/^\s*\[/m)[0]
    const m = /^\s*model\s*=\s*"([\w.:/@-]{1,200})"\s*(?:#.*)?$/m.exec(top)
    return m?.[1]
  } catch {
    return undefined
  }
}

export const codex: AgentAdapter = {
  id: 'codex',
  label: 'Codex',
  binary: 'codex',
  turnMode: 'exec',
  // Codex reads $HOME/.agents/skills/<name> (direct children only); ~/.codex/skills is its legacy folder.
  skillRoots: (home) => [join(home, '.agents/skills'), join(home, '.codex/skills')],
  args: buildCodexArgs,
  firstMessage: (prompt) => prompt,
  userMessage: (text) => text,
  signal(event) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string')
      return { type: 'init', sessionId: event.thread_id }
    if (event.type === 'turn.completed') {
      const u = isObj(event.usage) ? event.usage : {}
      return { type: 'turn-end', usage: { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) } }
    }
    if (event.type === 'turn.failed') {
      const err = isObj(event.error) ? event.error.message : undefined
      return { type: 'turn-end', error: typeof err === 'string' && err ? err : 'The Codex turn failed.' }
    }
    if (typeof event.type === 'string' && event.type.startsWith('item.') && isObj(event.item) && event.item.type)
      return { type: 'keep', content: true }
    return { type: 'keep' }
  },
  explainFailure(stderr) {
    if (/not logged in|login required|401 Unauthorized|please (?:run )?`?codex login/i.test(stderr))
      return 'Codex is not signed in. Run "codex login" in a terminal, then try again.'
    if (/unexpected argument|unrecognized|unknown option/i.test(stderr))
      return 'Your Codex CLI does not accept an option Huntgry passes. Update Codex (brew upgrade codex), then try again.'
    return null
  }
}
