import type { TranscriptItem } from './runner-types'

/**
 * Folds the raw events of a run into what the Tailor page shows. Events are
 * `claude --output-format stream-json` lines plus the ones Huntgry records
 * itself (`type: 'huntgry'`: the user's messages, notices, stderr). Unknown
 * event types are skipped, so a newer Claude Code adding events is harmless.
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

export function buildTranscript(events: readonly unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const tools = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>()
  let n = 0
  const nextId = () => `i${n++}`

  for (const ev of events) {
    if (!isObj(ev)) continue
    const type = ev.type

    if (type === 'huntgry') {
      if (ev.subtype === 'user_message') items.push({ kind: 'user', id: nextId(), text: str(ev.text) })
      else if (ev.subtype === 'notice')
        items.push({ kind: 'notice', id: nextId(), level: ev.level === 'error' ? 'error' : 'info', text: str(ev.text) })
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
