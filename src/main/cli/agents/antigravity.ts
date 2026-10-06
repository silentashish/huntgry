import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TokenUsage } from '@shared/runner-types'
import { isObj, num, usageOf, type AgentAdapter, type AgentInvocation, type Json } from './types'

/**
 * Google Antigravity CLI: `agy` in print mode with stream-json in and out, one
 * process for the conversation (one NDJSON message per turn on stdin),
 * resumed with `--conversation <id>`.
 *
 * - `--print=` (empty): `-p` takes the prompt as its value, so `-p --flag`
 *   would swallow the next flag; the turns come from stdin instead.
 * - No system-prompt flag: Huntgry's context is prefixed to the first message.
 * - `--sandbox`: terminal commands run in a Seatbelt profile with no network,
 *   seeing only the workspace and the `--add-dir` folders (skill, venv, TeX).
 *   Those folders also become editable by agy's file tools: a gap compared
 *   with the Claude setup, documented in docs/changes/22-multi-agent.md.
 * - `--mode accept-edits`: workspace edits need no approval; anything else
 *   that would ask is soft-denied in headless mode. Never
 *   `--dangerously-skip-permissions`.
 * - `--disable-slash-commands`: a job posting cannot trigger slash commands.
 */

export function buildAntigravityArgs(inv: AgentInvocation): string[] {
  const { workspace, skillDir, venvDir, texRoot, extraRead = [] } = inv.sandbox
  const dirs = [...new Set([skillDir, venvDir, ...(texRoot ? [texRoot] : []), ...extraRead])].filter(
    (d) => d && d !== workspace
  )
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--mode',
    'accept-edits',
    '--sandbox',
    // 0 = no time limit: a LaTeX build can take minutes.
    '--print-timeout',
    '0',
    '--disable-slash-commands',
    ...dirs.flatMap((d) => ['--add-dir', d]),
    ...(inv.model ? ['--model', inv.model] : []),
    ...(inv.resumeSessionId ? ['--conversation', inv.resumeSessionId] : []),
    '--print='
  ]
}

/**
 * The model agy runs with: Huntgry passes no `--model`, so it is the one chosen in agy's own
 * settings (`~/.gemini/antigravity-cli/settings.json` → `model`, a display name such as
 * `Claude Opus 4.6 (Thinking)`). Only used to price the run (#44); `undefined` when unknown.
 */
export async function agyModel(home: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'))
    const model = isObj(parsed) ? parsed.model : undefined
    return typeof model === 'string' && /^[\w .:/@()[\]-]{1,200}$/.test(model) ? model : undefined
  } catch {
    return undefined
  }
}

/** `AGY_ERROR: {"short_error": …, "error_code": 429, …}` on stderr → a readable reason. */
export function explainAgyError(stderr: string): string | null {
  const lines = stderr.split('\n').filter((l) => l.startsWith('AGY_ERROR:'))
  const last = lines[lines.length - 1]
  if (!last) {
    if (/not (?:signed|logged) in|authenticat/i.test(stderr))
      return 'Antigravity is not signed in. Run "agy" once in a terminal and sign in, then try again.'
    return null
  }
  let info: Record<string, unknown> = {}
  try {
    const v: unknown = JSON.parse(last.slice('AGY_ERROR:'.length))
    if (isObj(v)) info = v
  } catch {
    return last.slice('AGY_ERROR:'.length).trim() || null
  }
  const short = typeof info.short_error === 'string' ? info.short_error : 'Antigravity reported an error.'
  if (info.error_code === 429 || info.status === 'RESOURCE_EXHAUSTED')
    return `Antigravity's quota is used up: ${short} Try again later, or pick another agent.`
  return short
}

/**
 * `result.usage` → `TokenUsage` (#44), read the way the Gemini API counts: `input_tokens`
 * include `cache_read_tokens`, and `thinking_tokens` come on top of `output_tokens` (both billed
 * as output). When the cache count is larger than the input, the two are taken as separate.
 * The turn's own counts (one `result` per turn). Not confirmed on a cache hit yet: see
 * docs/changes/44-run-observability.md.
 */
export function agyUsage(u: Json): TokenUsage {
  const input = num(u.input_tokens)
  const cached = num(u.cache_read_tokens)
  const thinking = num(u.thinking_tokens)
  return usageOf({
    inputTokens: cached <= input ? input - cached : input,
    cacheReadTokens: cached,
    outputTokens: num(u.output_tokens) + thinking,
    reasoningTokens: thinking
  })
}

export const antigravity: AgentAdapter = {
  id: 'antigravity',
  label: 'Antigravity',
  binary: 'agy',
  turnMode: 'stream',
  // The CLI's user skills folder, then the one Antigravity 2.0 / the IDE reads.
  skillRoots: (home) => [join(home, '.gemini/antigravity-cli/skills'), join(home, '.gemini/config/skills')],
  args: buildAntigravityArgs,
  firstMessage: (prompt, systemPrompt) =>
    `<huntgry_instructions>\n${systemPrompt}\n</huntgry_instructions>\n\n${prompt}`,
  userMessage: (text) => `${JSON.stringify({ event: 'user', message: { content: text } })}\n`,
  signal(event) {
    if (event.event === 'init' && typeof event.conversation_id === 'string' && event.conversation_id)
      return { type: 'init', sessionId: event.conversation_id }
    if (event.event === 'result' && isObj(event.result)) {
      const r = event.result
      const u = isObj(r.usage) ? r.usage : {}
      const ok = r.status === 'SUCCESS'
      return {
        type: 'turn-end',
        sessionId: typeof r.conversation_id === 'string' && r.conversation_id ? r.conversation_id : undefined,
        usage: agyUsage(u),
        usageScope: 'turn',
        ...(num(r.duration_seconds) > 0 ? { durationMs: Math.round(num(r.duration_seconds) * 1000) } : {}),
        error: ok ? undefined : (typeof r.error === 'string' && r.error) || `Antigravity ended the turn: ${String(r.status)}`
      }
    }
    return { type: 'keep' }
  },
  explainFailure: (stderr) => explainAgyError(stderr)
}
