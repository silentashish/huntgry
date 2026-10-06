import type { AgentId, TokenCount, TranscriptItem } from './runner-types'

/**
 * Folds the raw events of a run into what the Tailor page shows. Events are
 * the agent CLI's own JSON lines (Claude stream-json, Codex `exec --json`,
 * Antigravity stream-json) plus the ones Huntgry records itself
 * (`type: 'huntgry'`: the user's messages, notices). Every agent folds into
 * the same `TranscriptItem`s. Unknown event types are skipped, so a newer CLI
 * adding events is harmless.
 */

/** Events Huntgry writes into `events.jsonl` next to Claude's own. */
export type HuntgryEvent =
  | { type: 'huntgry'; subtype: 'user_message'; text: string; ts: string }
  | { type: 'huntgry'; subtype: 'notice'; level: 'info' | 'error'; text: string; ts: string }

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Longest tool output kept in the transcript; the full text stays in `events.jsonl`. */
const MAX_TOOL_OUTPUT = 4000

type Tool = Extract<TranscriptItem, { kind: 'tool' }>

/** The user's messages and Huntgry's notices, the same for every agent. `true` when `ev` was one. */
function foldHuntgry(ev: Json, items: TranscriptItem[], nextId: () => string): boolean {
  if (ev.type !== 'huntgry') return false
  if (ev.subtype === 'user_message') items.push({ kind: 'user', id: nextId(), text: str(ev.text) })
  else if (ev.subtype === 'notice')
    items.push({ kind: 'notice', id: nextId(), level: ev.level === 'error' ? 'error' : 'info', text: str(ev.text) })
  return true
}

/** `run.agent` picks the fold; runs recorded before agents could be chosen are Claude runs. */
export function buildTranscript(events: readonly unknown[], agent: AgentId = 'claude'): TranscriptItem[] {
  if (agent === 'codex') return buildCodexTranscript(events)
  if (agent === 'antigravity') return buildAntigravityTranscript(events)
  return buildClaudeTranscript(events)
}

function buildClaudeTranscript(events: readonly unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let turn = 0
  const tools = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>()
  let n = 0
  const nextId = () => `i${n++}`

  for (const ev of events) {
    if (!isObj(ev)) continue
    const type = ev.type

    if (foldHuntgry(ev, items, nextId)) {
      if (ev.subtype === 'user_message') turn++
      continue
    }

    if (type === 'assistant' && isObj(ev.message) && Array.isArray(ev.message.content)) {
      // Only top-level turns; sub-agent chatter (parent_tool_use_id set) stays in the log.
      if (typeof ev.parent_tool_use_id === 'string') continue
      const messageId = str(ev.message.id)
      for (const block of ev.message.content) {
        if (!isObj(block)) continue
        if (block.type === 'text' && str(block.text).trim()) {
          const last = items[items.length - 1]
          // Streamed blocks of the same message arrive as separate events; keep them as one bubble.
          if (last?.kind === 'assistant' && messageId && last.id.endsWith(`#${messageId}`)) {
            last.text += `\n\n${str(block.text)}`
          } else {
            items.push({ kind: 'assistant', id: `${nextId()}#${messageId}`, text: str(block.text) })
          }
        } else if (block.type === 'tool_use') {
          const item = {
            kind: 'tool' as const,
            id: str(block.id) || nextId(),
            name: str(block.name),
            summary: summarizeToolInput(str(block.name), block.input),
            status: 'running' as const
          }
          tools.set(item.id, item)
          items.push(item)
        }
      }
      continue
    }

    if (type === 'user' && isObj(ev.message) && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (!isObj(block) || block.type !== 'tool_result') continue
        const tool = tools.get(str(block.tool_use_id))
        if (!tool) continue
        tool.status = block.is_error === true ? 'error' : 'ok'
        tool.output = truncate(toolResultText(block.content), MAX_TOOL_OUTPUT)
      }
      continue
    }

    if (type === 'result') {
      const denials = Array.isArray(ev.permission_denials)
        ? ev.permission_denials.map((d) =>
            isObj(d) ? `${str(d.tool_name)} ${summarizeToolInput(str(d.tool_name), d.tool_input)}`.trim() : ''
          )
        : []
      items.push({
        kind: 'result',
        id: nextId(),
        turn,
        ok: ev.is_error !== true && ev.subtype === 'success',
        text: str(ev.result) || str(ev.subtype),
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : 0,
        denials: denials.filter(Boolean)
      })
      // A tool still "running" when the turn ended never got a result (interrupted).
      for (const tool of tools.values()) if (tool.status === 'running') tool.status = 'error'
    }
  }
  return items
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function usageOf(u: unknown): TokenCount {
  return isObj(u) ? { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) } : { inputTokens: 0, outputTokens: 0 }
}

/** `12.3k in · 400 out`. */
export function formatUsage(u: TokenCount): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))
  return `${k(u.inputTokens)} tokens in · ${k(u.outputTokens)} out`
}

/**
 * Codex `exec --json`: `item.started` / `item.completed` carry agent messages,
 * shell commands, file changes and MCP calls; `turn.completed` / `turn.failed`
 * end a turn. Reasoning and to-do items stay in the log.
 */
function buildCodexTranscript(events: readonly unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const tools = new Map<string, Tool>()
  let n = 0
  let turn = 0
  const nextId = () => `i${n++}`
  let lastMessage = ''

  const tool = (key: string, name: string, summary: string): Tool => {
    let t = tools.get(key)
    if (!t) {
      t = { kind: 'tool', id: key, name, summary, status: 'running' }
      tools.set(key, t)
      items.push(t)
    }
    return t
  }

  for (const ev of events) {
    if (!isObj(ev)) continue
    if (foldHuntgry(ev, items, nextId)) {
      if (ev.subtype === 'user_message') turn++
      continue
    }
    const type = ev.type
    if ((type === 'item.started' || type === 'item.completed' || type === 'item.updated') && isObj(ev.item)) {
      const it = ev.item
      // Item ids restart at item_0 in every `exec` process: key them by turn.
      const key = `t${turn}:${str(it.id) || nextId()}`
      const done = type === 'item.completed'
      switch (it.type) {
        case 'agent_message':
          if (done && str(it.text).trim()) {
            items.push({ kind: 'assistant', id: nextId(), text: str(it.text) })
            lastMessage = str(it.text)
          }
          break
        case 'command_execution': {
          const t = tool(key, 'Bash', truncate(str(it.command), 160))
          if (done || (it.status !== 'in_progress' && it.status !== undefined)) {
            const exit = typeof it.exit_code === 'number' ? it.exit_code : null
            t.status = it.status === 'failed' || it.status === 'declined' || (exit !== null && exit !== 0) ? 'error' : 'ok'
            if (str(it.aggregated_output)) t.output = truncate(str(it.aggregated_output), MAX_TOOL_OUTPUT)
          }
          break
        }
        case 'file_change': {
          const paths = Array.isArray(it.changes) ? it.changes.map((c) => (isObj(c) ? baseName(str(c.path)) : '')) : []
          const t = tool(key, 'Edit', truncate(paths.filter(Boolean).join(', '), 160))
          if (done) t.status = it.status === 'failed' ? 'error' : 'ok'
          break
        }
        case 'mcp_tool_call': {
          const t = tool(key, `${str(it.server)}/${str(it.tool)}`, truncate(JSON.stringify(it.arguments ?? {}), 160))
          if (done || it.status === 'failed' || it.status === 'completed') {
            const err = isObj(it.error) ? str(it.error.message) : ''
            t.status = it.status === 'failed' || err ? 'error' : 'ok'
            if (err) t.output = truncate(err, MAX_TOOL_OUTPUT)
          }
          break
        }
        case 'web_search': {
          const t = tool(key, 'WebSearch', truncate(str(it.query), 160))
          if (done) t.status = 'ok'
          break
        }
        case 'error':
          if (done) items.push({ kind: 'notice', id: nextId(), level: 'error', text: str(it.message) })
          break
      }
      continue
    }
    if (type === 'turn.completed' || type === 'turn.failed') {
      const ok = type === 'turn.completed'
      const err = isObj(ev.error) ? str(ev.error.message) : ''
      items.push({
        kind: 'result',
        id: nextId(),
        turn,
        ok,
        text: ok ? lastMessage : err || 'The turn failed.',
        costUsd: 0,
        durationMs: 0,
        denials: [],
        usage: usageOf(ev.usage)
      })
      for (const t of tools.values()) if (t.status === 'running') t.status = 'error'
      continue
    }
    if (type === 'error' && str(ev.message)) items.push({ kind: 'notice', id: nextId(), level: 'error', text: str(ev.message) })
  }
  return items
}

/**
 * Antigravity stream-json: `step_update` events stream the agent's text
 * (`text_delta`, accumulated per step) and its tool calls (`tool_info`); one
 * `result` per turn with status, usage and refused actions.
 */
function buildAntigravityTranscript(events: readonly unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const tools = new Map<string, Tool>()
  const texts = new Map<string, Extract<TranscriptItem, { kind: 'assistant' }>>()
  let n = 0
  let turn = 0
  const nextId = () => `i${n++}`

  for (const ev of events) {
    if (!isObj(ev)) continue
    if (foldHuntgry(ev, items, nextId)) {
      if (ev.subtype === 'user_message') turn++
      continue
    }
    if (ev.event === 'step_update' && isObj(ev.step_update)) {
      const st = ev.step_update
      const key = `t${turn}:${num(st.step_index)}`
      if (st.step_type === 'agent_response' || st.step_type === 'planner_response') {
        const delta = str(st.text_delta)
        if (!delta) continue
        const item = texts.get(key)
        if (item) item.text += delta
        else {
          const created = { kind: 'assistant' as const, id: `${nextId()}#${key}`, text: delta }
          texts.set(key, created)
          items.push(created)
        }
      } else if (st.step_type === 'tool') {
        const info = isObj(st.tool_info) ? st.tool_info : {}
        const name = str(st.tool_name) || str(info.name) || 'tool'
        let t = tools.get(key)
        if (!t) {
          t = { kind: 'tool', id: key, name, summary: summarizeToolInput(name, info.parameters), status: 'running' }
          tools.set(key, t)
          items.push(t)
        }
        const err = isObj(info.error) ? str(info.error.message) || str(info.error.type) : ''
        if (str(info.output) || err) t.output = truncate(err || str(info.output), MAX_TOOL_OUTPUT)
        if (st.state === 'DONE' || err) t.status = err ? 'error' : 'ok'
      }
      continue
    }
    if (ev.event === 'result' && isObj(ev.result)) {
      const r = ev.result
      const ok = r.status === 'SUCCESS'
      const denied = Array.isArray(r.denied_actions) ? r.denied_actions : Array.isArray(ev.denied_actions) ? ev.denied_actions : []
      items.push({
        kind: 'result',
        id: nextId(),
        turn,
        ok,
        text: ok ? str(r.response) : str(r.error) || str(r.status) || 'The turn failed.',
        costUsd: 0,
        durationMs: Math.round(num(r.duration_seconds) * 1000),
        denials: denied
          .map((d) =>
            typeof d === 'string'
              ? d
              : isObj(d)
                ? `${str(d.tool_name) || str(d.name)} ${summarizeToolInput(str(d.tool_name) || str(d.name), d.parameters ?? d.tool_input)}`.trim()
                : ''
          )
          .filter(Boolean),
        usage: usageOf(r.usage)
      })
      for (const t of tools.values()) if (t.status === 'running') t.status = 'error'
    }
  }
  return items
}

/** One line describing what a tool call does, e.g. `build.py resume_data.json …` or `job-description.md`. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!isObj(input)) return ''
  const pick = (...keys: string[]) => keys.map((k) => str(input[k])).find(Boolean) ?? ''
  switch (name) {
    case 'Bash':
      return truncate(pick('description') || pick('command'), 160)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return baseName(pick('file_path', 'notebook_path'))
    case 'Glob':
    case 'Grep':
      return truncate(pick('pattern'), 120)
    case 'WebFetch':
      return truncate(pick('url'), 160)
    case 'WebSearch':
      return truncate(pick('query'), 160)
    case 'Skill':
      return pick('skill', 'command')
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : ''
    // Antigravity's tools.
    case 'run_command':
      return truncate(pick('CommandLine', 'command', 'Command'), 160)
    case 'view_file':
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return baseName(pick('AbsolutePath', 'TargetFile', 'file_path', 'path'))
    case 'list_dir':
      return pick('DirectoryPath', 'path')
    case 'grep_search':
    case 'find_by_name':
      return truncate(pick('Query', 'Pattern', 'query', 'pattern'), 120)
    default:
      return truncate(pick('description', 'prompt', 'file_path', 'url', 'command') || JSON.stringify(input), 160)
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) ? (c.type === 'text' ? str(c.text) : c.type === 'image' ? '[image]' : '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function truncate(s: string, max: number): string {
  const one = s.length > max ? `${s.slice(0, max)}…` : s
  return one
}

/** Splits a byte stream into complete lines; keeps the partial tail for the next chunk. */
export class LineBuffer {
  private tail = ''

  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split('\n')
    this.tail = parts.pop() ?? ''
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')
  }

  /** Whatever is left when the stream ends. */
  flush(): string[] {
    const rest = this.tail.trim()
    this.tail = ''
    return rest ? [rest] : []
  }
}

/** Parses one stream-json line; `null` for anything that is not a JSON object. */
export function parseEventLine(line: string): Json | null {
  try {
    const v: unknown = JSON.parse(line)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Adds a live event (`seq` = its index in `events.jsonl`) to events loaded
 * from disk. Events the list already holds are skipped, so a live copy of an
 * event that was also read from the file is not shown twice.
 */
export function appendLive(events: readonly unknown[], seq: number, event: unknown): unknown[] {
  return seq < events.length ? (events as unknown[]) : [...events, event]
}
