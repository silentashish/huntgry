import type { AgentId, RunRateLimit } from '@shared/runner-types'

/**
 * What a failed unattended run means (pure, tested): a usage limit or quota
 * (pause the pipeline until the reset), a burst limit or another transient
 * error (retry with backoff), a stall (the watchdog killed it; retry), or a
 * permanent error (fail). Each agent words these differently; the texts here
 * were captured from Claude Code 2.1.286, Codex 0.159.2 and Antigravity
 * 1.2.14 (see docs/changes/31-unattended-pipeline.md).
 */

export type FailureKind = 'usage-limit' | 'spend-limit' | 'burst-limit' | 'transient' | 'stall' | 'permanent'

export interface Failure {
  kind: FailureKind
  /** For `usage-limit`: when the limit resets (ms epoch) and whether that came from the agent or is a guess. */
  resetAt?: number
  parsed?: boolean
  message: string
}

export interface FailureInput {
  agent: AgentId
  error: string | undefined
  /** Claude's last `rate_limit_event` on the run, when any. */
  rateLimit?: RunRateLimit
}

/** Reason the watchdog gives when it kills a run; `classifyFailure` recognises it. */
export const STALL_PREFIX = 'No output for'

const CLAUDE_USAGE = /You.ve hit your (?:session|weekly|monthly|Opus|Sonnet|Haiku|\w+) limit/i
const CLAUDE_SPEND = /hit your .*spend limit|spend limit/i
const CLAUDE_BURST = /temporarily limiting requests|Request rejected \(429\)|too many requests/i
const CODEX_USAGE = /hit your usage limit|reached your usage limit|usage_limit_exceeded|usage limit reached/i
const CODEX_SPEND = /out of credits|purchase more credits(?!.*try again)/i
const CODEX_BURST = /rate_limit_exceeded|rate limit/i
const AGY_QUOTA = /RESOURCE_EXHAUSTED|error_code.{0,5}429|quota/i
const TRANSIENT =
  /\b5[0-9]{2}\b|overloaded|server_error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|stream disconnected|exited before the turn ended|exited with (?:signal|code)|panic|network|timed? ?out|temporar/i
const PERMANENT =
  /not signed in|not logged in|auth login|unknown option|unexpected argument|skill (?:was not found|is not installed|cannot see)|error_max_turns|max turns|permission denied|ENOENT|still fails/i

/**
 * When the limit resets, from the agent's text: Claude `resets 3:45pm` /
 * `resets Mon 12:00am` (local time, an optional `(Area/City)` suffix is
 * ignored), Codex `try again at Sep 24th, 2026 7:24 AM` (local), Antigravity
 * `Resets in 34h23m28s` (relative). A time in the past rolls to the next day
 * (or week); more than 8 days ahead reads as unparsed.
 */
export function parseResetTime(agent: AgentId, text: string, now: number): { at: number; parsed: true } | { parsed: false } {
  const at = agent === 'antigravity' ? relative(text, now) : agent === 'codex' ? codexTime(text, now) : claudeTime(text, now)
  if (at === null || !Number.isFinite(at)) return { parsed: false }
  if (at - now > 8 * 24 * 3600_000 || at < now - 60_000) return { parsed: false }
  return { at, parsed: true }
}

function relative(text: string, now: number): number | null {
  const m = /Resets? in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text)
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000
  return ms > 0 ? now + ms : null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function codexTime(text: string, now: number): number | null {
  const m = /try again at\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])/.exec(text)
  if (!m) return claudeTime(text, now)
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  const d = new Date(Number(m[3]), month, Number(m[2]), hour24(Number(m[4]), m[6]), Number(m[5]), 0, 0)
  return d.getTime()
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function hour24(h: number, ampm: string): number {
  const pm = ampm.toLowerCase() === 'pm'
  if (h === 12) return pm ? 12 : 0
  return pm ? h + 12 : h
}

function claudeTime(text: string, now: number): number | null {
  const m = /resets?\s+(?:([A-Za-z]{3})[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])/.exec(text)
  if (!m) return null
  const day = m[1] ? DAYS.indexOf(m[1].toLowerCase()) : -1
  if (m[1] && day < 0) return null
  const d = new Date(now)
  d.setHours(hour24(Number(m[2]), m[4]), Number(m[3] ?? 0), 0, 0)
  if (day >= 0) {
    let delta = (day - d.getDay() + 7) % 7
    if (delta === 0 && d.getTime() <= now) delta = 7
    d.setDate(d.getDate() + delta)
  } else if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

/** Decides what a failure means; Claude's `rate_limit_event.resetsAt` epoch beats any text. */
export function classifyFailure(input: FailureInput, now = Date.now()): Failure {
  const text = input.error ?? ''
  const message = text.split('\n').find((l) => l.trim()) ?? 'The run failed.'
  const limit = (): Failure => {
    if (input.rateLimit?.status === 'rejected' && input.rateLimit.resetsAt) {
      const at = input.rateLimit.resetsAt * 1000
      if (at > now - 60_000 && at - now <= 8 * 24 * 3600_000) return { kind: 'usage-limit', resetAt: at, parsed: true, message }
    }
    const r = parseResetTime(input.agent, text, now)
    return r.parsed ? { kind: 'usage-limit', resetAt: r.at, parsed: true, message } : { kind: 'usage-limit', parsed: false, message }
  }
  if (text.startsWith(STALL_PREFIX)) return { kind: 'stall', message }
  if (input.rateLimit?.status === 'rejected') return limit()
  switch (input.agent) {
    case 'claude':
      if (CLAUDE_SPEND.test(text)) return { kind: 'spend-limit', message }
      if (CLAUDE_USAGE.test(text)) return limit()
      if (CLAUDE_BURST.test(text)) return { kind: 'burst-limit', message }
      break
    case 'codex':
      if (CODEX_USAGE.test(text)) return limit()
      if (CODEX_SPEND.test(text)) return { kind: 'spend-limit', message }
      if (CODEX_BURST.test(text)) return { kind: 'burst-limit', message }
      break
    case 'antigravity':
      if (AGY_QUOTA.test(text)) return limit()
      break
  }
  if (PERMANENT.test(text)) return { kind: 'permanent', message }
  if (TRANSIENT.test(text)) return { kind: 'transient', message }
  return { kind: 'transient', message }
}

/** Retries an unattended item gets for transient failures, burst limits and stalls. */
export const MAX_RETRIES = 2
const BACKOFF_MS = [30_000, 120_000]

/** 30 s, then 120 s, ±20 % jitter. `retries` = retries already used (0 for the first). */
export function backoffDelay(retries: number, random = Math.random): number {
  const base = BACKOFF_MS[Math.min(retries, BACKOFF_MS.length - 1)]
  return Math.round(base * (0.8 + random() * 0.4))
}

/** How long to wait when a limit's reset time could not be read: 60 min, 2 h, 4 h, then 4 h. */
export function unparsedLimitWait(strikes: number): number {
  return [60, 120, 240][Math.min(strikes, 2)] * 60_000
}

/** Margin added to a parsed reset time before trying again. */
export const LIMIT_MARGIN_MS = 2 * 60_000
