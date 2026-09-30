/**
 * Runtime checks for everything that arrives over the wire, hand-written in the style of the
 * desktop's `ipc.ts` validators (no schema library, ADR-0001 open question 10). Every guard
 * throws a `ProtocolError` whose `code` is the `Envelope.error.code` to answer with, so a
 * gateway can do `try { … } catch (e) { reply(errorOf(e)) }`.
 *
 * Producers call the same guards before encrypting, so an oversized or malformed frame never
 * leaves the phone or the desktop.
 */

import { LIMITS, MAX_CLOCK_SKEW_SECONDS, TTL_SECONDS, utf8Bytes } from './limits'
import {
  COSTLY_COMMANDS,
  NOTIFICATION_CATEGORIES,
  PROTOCOL,
  READ_COMMANDS,
  REMOTE_AGENT_IDS,
  REMOTE_COMMAND_NAMES,
  REMOTE_DATE_STYLES,
  REMOTE_EVENT_NAMES,
  REMOTE_MAX_CONCURRENCY,
  REMOTE_MAX_JOBS,
  WORKSPACE_FREE_COMMANDS,
  type Envelope,
  type EnvelopeError,
  type EnvelopeErrorCode,
  type EnvelopeKind,
  type FileChunk,
  type HelloBody,
  type NotificationCategory,
  type PipelineStartInput,
  type ProtocolRange,
  type RelayClientFrame,
  type RelayFrame,
  type RelayNotice,
  type RemoteAgentId,
  type RemoteCommand,
  type RemoteCommandName,
  type RemoteDateStyle,
  type RemoteEnqueueInput,
  type RemoteEvent,
  type RemoteEventName,
  type RemoteFile
} from './protocol'

export class ProtocolError extends Error {
  readonly code: EnvelopeErrorCode
  constructor(code: EnvelopeErrorCode, message: string) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

/** The `Envelope.error` to answer with for any thrown value (unknown errors become `failed`). */
export function errorOf(e: unknown): EnvelopeError {
  if (e instanceof ProtocolError) return { code: e.code, message: e.message }
  return { code: 'failed', message: e instanceof Error ? e.message : String(e) }
}

const invalid = (message: string): never => {
  throw new ProtocolError('invalid', message)
}

// ── primitives ──────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function requireRecord(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) invalid(`${what} must be an object.`)
  return v as Record<string, unknown>
}

/** A non-empty string of at most `maxChars` characters (ids, names). */
export function requireId(v: unknown, what: string, maxChars: number = LIMITS.idChars): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxChars) invalid(`${what} must be a string of 1–${maxChars} characters.`)
  return v as string
}

export function requireApplicationId(v: unknown, what = 'applicationId'): string {
  return requireId(v, what, LIMITS.applicationIdChars)
}

export function requireJobId(v: unknown, what = 'jobId'): string {
  return requireId(v, what, LIMITS.jobIdChars)
}

export function requireCursor(v: unknown, what = 'cursor'): string {
  return requireId(v, what, LIMITS.cursorChars)
}

/** A string (possibly empty) whose UTF-8 length is at most `maxBytes`. */
export function requireText(v: unknown, what: string, maxBytes: number = LIMITS.textBytes): string {
  if (typeof v !== 'string') invalid(`${what} must be a string.`)
  if (utf8Bytes(v as string) > maxBytes) invalid(`${what} exceeds ${maxBytes} bytes.`)
  return v as string
}

export function requireShortString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length > LIMITS.shortStringChars) invalid(`${what} must be a string of at most ${LIMITS.shortStringChars} characters.`)
  return v as string
}

export function requireBoolean(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') invalid(`${what} must be a boolean.`)
  return v as boolean
}

export function requireInteger(v: unknown, what: string, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid(`${what} must be an integer between ${min} and ${max}.`)
  return v as number
}

export function requireNumber(v: unknown, what: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) invalid(`${what} must be a number ≥ ${min}.`)
  return v as number
}

/** An ISO-8601 timestamp that `Date.parse` accepts. */
export function requireIsoDate(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length > 64 || Number.isNaN(Date.parse(v))) invalid(`${what} must be an ISO date.`)
  return v as string
}

export function requireOneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) invalid(`${what} must be one of ${list.join(', ')}.`)
  return v as T
}

function requireStringArray(v: unknown, what: string, maxItems: number, maxChars: number = LIMITS.idChars): string[] {
  if (!Array.isArray(v) || v.length > maxItems) invalid(`${what} must be an array of at most ${maxItems} items.`)
  return (v as unknown[]).map((item, i) => requireId(item, `${what}[${i}]`, maxChars))
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) invalid(`${what} has an unknown field "${key}".`)
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
function requireBase64(v: unknown, what: string, bytes?: number): string {
  if (typeof v !== 'string' || v.length % 4 !== 0 || !BASE64_RE.test(v)) invalid(`${what} must be base64.`)
  if (bytes !== undefined && Math.ceil(bytes / 3) * 4 !== (v as string).length) invalid(`${what} must be ${bytes} bytes.`)
  return v as string
}

// ── enums ───────────────────────────────────────────────────────────────────────────────────

export function requireAgentId(v: unknown, what = 'agent'): RemoteAgentId {
  return requireOneOf(v, REMOTE_AGENT_IDS, what)
}

export function requireDateStyle(v: unknown, what = 'dateStyle'): RemoteDateStyle {
  return requireOneOf(v, REMOTE_DATE_STYLES, what)
}

export function requireConcurrency(v: unknown, what = 'concurrency'): number {
  return requireInteger(v, what, 1, REMOTE_MAX_CONCURRENCY)
}

export function requireNotificationCategory(v: unknown, what = 'category'): NotificationCategory {
  return requireOneOf(v, NOTIFICATION_CATEGORIES, what)
}

const REMOTE_FILE_RE = /^(resume\.pdf|cover\.pdf|review-notes\.md|(resume|cover)-page-\d{1,4}\.jpg)$/
export function requireRemoteFile(v: unknown, what = 'file'): RemoteFile {
  if (typeof v !== 'string' || !REMOTE_FILE_RE.test(v)) invalid(`${what} is not a file the phone may fetch.`)
  return v as RemoteFile
}

export function requireProtocolRange(v: unknown, what = 'protocol'): ProtocolRange {
  const r = requireRecord(v, what)
  const min = requireInteger(r.min, `${what}.min`, 1)
  const max = requireInteger(r.max, `${what}.max`, min)
  return { min, max }
}

/**
 * The protocol major both sides will speak: the highest common one. Throws `unsupported`
 * when the ranges do not overlap (the phone then asks to update Huntgry, or itself).
 */
export function negotiateProtocol(theirs: ProtocolRange, ours: ProtocolRange = PROTOCOL): number {
  const version = Math.min(theirs.max, ours.max)
  if (version < theirs.min || version < ours.min) {
    throw new ProtocolError('unsupported', `No common protocol version (theirs ${theirs.min}–${theirs.max}, ours ${ours.min}–${ours.max}).`)
  }
  return version
}

// ── TTL, freshness, sequence ────────────────────────────────────────────────────────────────

export function requireTtl(v: unknown, what = 'ttl'): number {
  return requireInteger(v, what, TTL_SECONDS.min, TTL_SECONDS.max)
}

/** The TTL a command should be sent with. */
export function ttlFor(name: RemoteCommandName, ttls: { costly: number; default: number } = { costly: 2 * 60 * 60, default: 24 * 60 * 60 }): number {
  return (COSTLY_COMMANDS as readonly string[]).includes(name) ? ttls.costly : ttls.default
}

/**
 * `now − ts ≤ ttl`, the receiver's own copy of what the relay enforced. Frames from the
 * future beyond `MAX_CLOCK_SKEW_SECONDS` are `invalid` (a wrong clock, not a replay).
 */
export function requireFresh(envelope: Pick<Envelope, 'ts' | 'ttl'>, now: number = Date.now()): void {
  const sent = Date.parse(envelope.ts)
  const ageSeconds = (now - sent) / 1000
  if (ageSeconds > envelope.ttl) throw new ProtocolError('expired', `Frame is ${Math.round(ageSeconds)} s old, ttl ${envelope.ttl} s.`)
  if (-ageSeconds > MAX_CLOCK_SKEW_SECONDS) invalid(`Frame timestamp is ${Math.round(-ageSeconds)} s in the future.`)
}

/**
 * Replay guard: `seq` must be greater than the last accepted one for this sender and session.
 * Returns the new `lastSeq` to persist. A rewound counter is `denied`: the peer must pair again.
 */
export function requireNextSeq(seq: number, lastSeq: number): number {
  requireInteger(seq, 'seq', 0)
  if (seq <= lastSeq) throw new ProtocolError('denied', `seq ${seq} is not above the last accepted ${lastSeq}; this device must be paired again.`)
  return seq
}

// ── Envelope ────────────────────────────────────────────────────────────────────────────────

const ENVELOPE_KINDS: readonly EnvelopeKind[] = ['hello', 'cmd', 'result', 'event', 'ping', 'pong']
const ENVELOPE_KEYS = ['v', 'sid', 'ws', 'from', 'seq', 'ts', 'ttl', 'kind', 'id', 're', 'name', 'ok', 'error', 'body'] as const
const ERROR_CODES: readonly EnvelopeErrorCode[] = ['unsupported', 'invalid', 'stale', 'denied', 'rate-limited', 'expired', 'failed']

export interface EnvelopeContext {
  /** The session the socket belongs to; a frame for another `sid` is `denied`. */
  sid?: string
  /** Who the frame must come from. */
  from?: Envelope['from']
  /** Protocol majors this side accepts (default `PROTOCOL`). */
  protocol?: ProtocolRange
}

/**
 * Shape of a decrypted envelope, before anything is trusted: field types, `v` within the
 * accepted range (`unsupported` otherwise), known `kind`, `ttl` bounds, `id` on commands,
 * `re` on results, `name` on commands and events, and the plaintext budget.
 * Freshness, sequence, workspace and command arguments are separate guards, because the
 * gateway checks them in a specific order (ADR "Commit order on the desktop").
 */
export function requireEnvelope(value: unknown, context: EnvelopeContext = {}): Envelope {
  const e = requireRecord(value, 'Envelope')
  rejectUnknownKeys(e, ENVELOPE_KEYS, 'Envelope')
  const range = context.protocol ?? PROTOCOL
  if (typeof e.v !== 'number' || !Number.isInteger(e.v)) invalid('Envelope.v must be an integer.')
  if ((e.v as number) < range.min || (e.v as number) > range.max) {
    throw new ProtocolError('unsupported', `Protocol ${e.v} is not supported (${range.min}–${range.max}).`)
  }
  const sid = requireId(e.sid, 'Envelope.sid')
  if (context.sid !== undefined && sid !== context.sid) throw new ProtocolError('denied', 'Frame belongs to another session.')
  const from = requireOneOf(e.from, ['desktop', 'phone'] as const, 'Envelope.from')
  if (context.from !== undefined && from !== context.from) throw new ProtocolError('denied', `Frame must come from the ${context.from}.`)
  const seq = requireInteger(e.seq, 'Envelope.seq', 0)
  const ts = requireIsoDate(e.ts, 'Envelope.ts')
  const ttl = requireTtl(e.ttl, 'Envelope.ttl')
  const kind = requireOneOf(e.kind, ENVELOPE_KINDS, 'Envelope.kind')
  const ws = e.ws === undefined ? undefined : requireId(e.ws, 'Envelope.ws')
  const id = e.id === undefined ? undefined : requireId(e.id, 'Envelope.id')
  const re = e.re === undefined ? undefined : requireId(e.re, 'Envelope.re')
  const name = e.name === undefined ? undefined : requireId(e.name, 'Envelope.name', 64)
  const ok = e.ok === undefined ? undefined : requireBoolean(e.ok, 'Envelope.ok')
  let error: EnvelopeError | undefined
  if (e.error !== undefined) {
    const r = requireRecord(e.error, 'Envelope.error')
    rejectUnknownKeys(r, ['code', 'message'], 'Envelope.error')
    error = { code: requireOneOf(r.code, ERROR_CODES, 'Envelope.error.code'), message: requireShortString(r.message, 'Envelope.error.message') }
  }
  if (kind === 'cmd' && (id === undefined || name === undefined)) invalid('A command needs id and name.')
  if (kind === 'result' && (re === undefined || ok === undefined)) invalid('A result needs re and ok.')
  if (kind === 'result' && ok === false && error === undefined) invalid('A failed result needs error.')
  if (kind === 'event' && name === undefined) invalid('An event needs name.')
  if (!('body' in e)) invalid('Envelope.body is required (use null).')
  if (utf8Bytes(JSON.stringify(value)) > LIMITS.plaintextBytes) invalid(`Envelope exceeds ${LIMITS.plaintextBytes} bytes.`)
  const out: Envelope = { v: e.v as 1, sid, from, seq, ts, ttl, kind, body: e.body }
  if (ws !== undefined) out.ws = ws
  if (id !== undefined) out.id = id
  if (re !== undefined) out.re = re
  if (name !== undefined) out.name = name
  if (ok !== undefined) out.ok = ok
  if (error !== undefined) out.error = error
  return out
}

/**
 * Workspace binding: every workspace-scoped command (all but `status.get` and `device.*`)
 * carries the open workspace's id. A mismatch is `invalid` ("workspace changed"); the phone
 * reloads its status and re-issues what still makes sense.
 */
export function requireWorkspace(envelope: Pick<Envelope, 'ws' | 'name'>, currentWorkspaceId: string): void {
  if (envelope.name !== undefined && (WORKSPACE_FREE_COMMANDS as readonly string[]).includes(envelope.name)) return
  if (envelope.ws === undefined) invalid('This command needs the workspace id (Envelope.ws).')
  if (envelope.ws !== currentWorkspaceId) invalid('Workspace changed: this command was sent for another workspace.')
}

/** Whether `name` is a command that may run again freely on redelivery. */
export function isReadCommand(name: string): boolean {
  return (READ_COMMANDS as readonly string[]).includes(name)
}

export function requireHelloBody(v: unknown): HelloBody {
  const r = requireRecord(v, 'hello')
  rejectUnknownKeys(r, ['protocol', 'name', 'appVersion', 'workspace'], 'hello')
  const out: HelloBody = {
    protocol: requireProtocolRange(r.protocol, 'hello.protocol'),
    name: requireId(r.name, 'hello.name'),
    appVersion: requireId(r.appVersion, 'hello.appVersion', 64)
  }
  if (r.workspace !== undefined) {
    const w = requireRecord(r.workspace, 'hello.workspace')
    rejectUnknownKeys(w, ['id', 'name'], 'hello.workspace')
    out.workspace = { id: requireId(w.id, 'hello.workspace.id'), name: requireId(w.name, 'hello.workspace.name') }
  }
  return out
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

export function requireEnqueueInput(v: unknown): RemoteEnqueueInput {
  const r = requireRecord(v, 'enqueue')
  rejectUnknownKeys(r, ['jobIds', 'options', 'concurrency', 'agent'], 'enqueue')
  const jobIds = requireStringArray(r.jobIds, 'jobIds', REMOTE_MAX_JOBS, LIMITS.jobIdChars)
  if (jobIds.length === 0) invalid('jobIds must not be empty.')
  const o = requireRecord(r.options, 'options')
  rejectUnknownKeys(o, ['coverLetter', 'dateStyle', 'notes'], 'options')
  const options: RemoteEnqueueInput['options'] = {
    coverLetter: requireBoolean(o.coverLetter, 'options.coverLetter'),
    dateStyle: requireDateStyle(o.dateStyle, 'options.dateStyle')
  }
  if (o.notes !== undefined) options.notes = requireText(o.notes, 'options.notes')
  const out: RemoteEnqueueInput = { jobIds, options }
  if (r.concurrency !== undefined) out.concurrency = requireConcurrency(r.concurrency)
  if (r.agent !== undefined) out.agent = requireAgentId(r.agent)
  return out
}

export function requirePipelineStartInput(v: unknown): PipelineStartInput {
  const r = requireRecord(v, 'pipeline.start')
  rejectUnknownKeys(r, ['jobIds', 'concurrency', 'agent', 'fallback', 'budget', 'options'], 'pipeline.start')
  const jobIds = requireStringArray(r.jobIds, 'jobIds', REMOTE_MAX_JOBS, LIMITS.jobIdChars)
  if (jobIds.length === 0) invalid('jobIds must not be empty.')
  const out: PipelineStartInput = { jobIds, concurrency: requireConcurrency(r.concurrency), agent: requireAgentId(r.agent) }
  if (r.fallback !== undefined) {
    out.fallback = requireAgentId(r.fallback, 'fallback')
    if (out.fallback === out.agent) invalid('fallback must differ from agent.')
  }
  if (r.budget !== undefined) {
    const b = requireRecord(r.budget, 'budget')
    rejectUnknownKeys(b, ['maxCostUsd', 'maxRuns'], 'budget')
    out.budget = {}
    if (b.maxCostUsd !== undefined) out.budget.maxCostUsd = requireNumber(b.maxCostUsd, 'budget.maxCostUsd')
    if (b.maxRuns !== undefined) out.budget.maxRuns = requireInteger(b.maxRuns, 'budget.maxRuns', 1, REMOTE_MAX_JOBS)
  }
  if (r.options !== undefined) {
    const o = requireRecord(r.options, 'options')
    rejectUnknownKeys(o, ['coverLetter', 'dateStyle'], 'options')
    out.options = { coverLetter: requireBoolean(o.coverLetter, 'options.coverLetter'), dateStyle: requireDateStyle(o.dateStyle, 'options.dateStyle') }
  }
  return out
}

function requireRevision(v: unknown): string {
  return requireId(v, 'revision', 128)
}

/** `sourceFact` ids are sha256 hex; keep them short and bounded. */
function requireReframingIds(v: unknown): string[] {
  return requireStringArray(v, 'approvedReframingIds', 200, 128)
}

function requireArgs(v: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  const r = requireRecord(v, `${name} args`)
  rejectUnknownKeys(r, keys, `${name} args`)
  return r
}

function requireNoArgs(v: unknown, name: string): void {
  if (v !== undefined && v !== null) {
    const r = requireRecord(v, `${name} args`)
    if (Object.keys(r).length > 0) invalid(`${name} takes no arguments.`)
  }
}

/**
 * The command allow-list and its arguments. An unknown name is `unsupported` (the phone greys
 * the button and asks to update Huntgry); wrong arguments are `invalid`. The result is a
 * fresh object with only the known fields, so the gateway never forwards extra ones.
 */
export function requireCommand(name: unknown, args: unknown): RemoteCommand {
  if (typeof name !== 'string' || !(REMOTE_COMMAND_NAMES as readonly string[]).includes(name)) {
    throw new ProtocolError('unsupported', `Unknown command${typeof name === 'string' ? ` "${name.slice(0, 64)}"` : ''}.`)
  }
  const n = name as RemoteCommandName
  switch (n) {
    case 'status.get':
    case 'queue.get':
    case 'pipeline.pause':
    case 'pipeline.resume':
    case 'pipeline.stop':
    case 'review.list':
      requireNoArgs(args, n)
      return { name: n } as RemoteCommand
    case 'queue.setPaused': {
      const a = requireArgs(args, n, ['paused'])
      return { name: n, args: { paused: requireBoolean(a.paused, 'paused') } }
    }
    case 'queue.cancel':
    case 'queue.retry': {
      const a = requireArgs(args, n, ['itemId'])
      return { name: n, args: { itemId: requireId(a.itemId, 'itemId') } }
    }
    case 'queue.enqueue':
      return { name: n, args: requireEnqueueInput(args) }
    case 'pipeline.start':
      return { name: n, args: requirePipelineStartInput(args) }
    case 'jobs.list': {
      const a = requireArgs(args, n, ['filter', 'cursor'])
      const out: { filter?: string; cursor?: string } = {}
      if (a.filter !== undefined) out.filter = requireId(a.filter, 'filter')
      if (a.cursor !== undefined) out.cursor = requireCursor(a.cursor)
      return { name: n, args: out }
    }
    case 'jobs.addUrl': {
      const a = requireArgs(args, n, ['url'])
      const url = requireShortString(a.url, 'url')
      if (!/^https?:\/\/\S+$/.test(url)) invalid('url must be an http(s) URL.')
      return { name: n, args: { url } }
    }
    case 'runs.list': {
      const a = requireArgs(args, n, ['cursor'])
      return { name: n, args: a.cursor === undefined ? {} : { cursor: requireCursor(a.cursor) } }
    }
    case 'run.get': {
      const a = requireArgs(args, n, ['runId', 'sinceSeq'])
      const out: { runId: string; sinceSeq?: number } = { runId: requireId(a.runId, 'runId') }
      if (a.sinceSeq !== undefined) out.sinceSeq = requireInteger(a.sinceSeq, 'sinceSeq', 0)
      return { name: n, args: out }
    }
    case 'run.reply': {
      const a = requireArgs(args, n, ['runId', 'text'])
      const text = requireText(a.text, 'text')
      if (text.trim().length === 0) invalid('text must not be empty.')
      return { name: n, args: { runId: requireId(a.runId, 'runId'), text } }
    }
    case 'run.finish':
    case 'run.stop': {
      const a = requireArgs(args, n, ['runId'])
      return { name: n, args: { runId: requireId(a.runId, 'runId') } }
    }
    case 'review.get': {
      const a = requireArgs(args, n, ['applicationId'])
      return { name: n, args: { applicationId: requireApplicationId(a.applicationId) } }
    }
    case 'review.approve': {
      const a = requireArgs(args, n, ['applicationId', 'revision', 'approvedReframingIds'])
      const out: Extract<RemoteCommand, { name: 'review.approve' }>['args'] = {
        applicationId: requireApplicationId(a.applicationId),
        revision: requireRevision(a.revision)
      }
      if (a.approvedReframingIds !== undefined) out.approvedReframingIds = requireReframingIds(a.approvedReframingIds)
      return { name: n, args: out }
    }
    case 'review.rerun': {
      const a = requireArgs(args, n, ['runId', 'revision', 'answers'])
      return { name: n, args: { runId: requireId(a.runId, 'runId'), revision: requireRevision(a.revision), answers: requireText(a.answers, 'answers') } }
    }
    case 'review.discard': {
      const a = requireArgs(args, n, ['applicationId', 'revision'])
      return { name: n, args: { applicationId: requireApplicationId(a.applicationId), revision: requireRevision(a.revision) } }
    }
    case 'file.get': {
      const a = requireArgs(args, n, ['applicationId', 'file', 'chunk'])
      return {
        name: n,
        args: { applicationId: requireApplicationId(a.applicationId), file: requireRemoteFile(a.file), chunk: requireInteger(a.chunk, 'chunk', 0, 100_000) }
      }
    }
    case 'device.setNotifications': {
      const a = requireArgs(args, n, ['categories'])
      if (!Array.isArray(a.categories) || a.categories.length > NOTIFICATION_CATEGORIES.length) invalid('categories must be an array.')
      const categories = (a.categories as unknown[]).map((c, i) => requireNotificationCategory(c, `categories[${i}]`))
      if (new Set(categories).size !== categories.length) invalid('categories must not repeat.')
      return { name: n, args: { categories } }
    }
  }
}

/** A `cmd` envelope's command: the name and `body` (its `args`) through `requireCommand`. */
export function requireCommandEnvelope(envelope: Envelope): RemoteCommand {
  if (envelope.kind !== 'cmd') invalid('Not a command envelope.')
  return requireCommand(envelope.name, envelope.body)
}

// ── Events (phone side) ─────────────────────────────────────────────────────────────────────

export function requireFileChunk(v: unknown): FileChunk {
  const r = requireRecord(v, 'file.chunk')
  rejectUnknownKeys(r, ['applicationId', 'file', 'chunk', 'of', 'bytes', 'sha256', 'data'], 'file.chunk')
  const of = requireInteger(r.of, 'of', 1, 100_000)
  const data = requireBase64(r.data, 'data')
  const decodedBytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  if (decodedBytes > LIMITS.fileChunkBytes) invalid(`file.chunk data exceeds ${LIMITS.fileChunkBytes} bytes.`)
  const sha256 = requireId(r.sha256, 'sha256', 64)
  if (!/^[0-9a-f]{64}$/.test(sha256)) invalid('sha256 must be 64 hex characters.')
  return {
    applicationId: requireApplicationId(r.applicationId),
    file: requireRemoteFile(r.file),
    chunk: requireInteger(r.chunk, 'chunk', 0, of - 1),
    of,
    bytes: requireInteger(r.bytes, 'bytes', 0),
    sha256,
    data
  }
}

/**
 * The event allow-list. Bodies are the projected DTOs; the phone checks the name and the
 * bounded fields that matter for safety (`file.chunk`), and renders the rest defensively.
 * An unknown event name is `unsupported` (a newer desktop; the phone ignores the event).
 */
export function requireEvent(name: unknown, body: unknown): RemoteEvent {
  if (typeof name !== 'string' || !(REMOTE_EVENT_NAMES as readonly string[]).includes(name)) {
    throw new ProtocolError('unsupported', `Unknown event${typeof name === 'string' ? ` "${name.slice(0, 64)}"` : ''}.`)
  }
  const n = name as RemoteEventName
  if (n === 'file.chunk') return { name: n, body: requireFileChunk(body) }
  if (n === 'applications.changed') {
    const r = requireRecord(body, name)
    return { name: n, body: { ids: requireStringArray(r.ids, 'ids', LIMITS.applicationsChangedIds, LIMITS.applicationIdChars) } }
  }
  if (n === 'device.revoked') {
    const r = requireRecord(body, name)
    return { name: n, body: { reason: requireShortString(r.reason, 'reason') } }
  }
  requireRecord(body, name)
  return { name: n, body } as RemoteEvent
}

// ── Relay layer ─────────────────────────────────────────────────────────────────────────────

const RELAY_FRAME_KEYS = ['to', 'ref', 'nonce', 'ct', 'ttl', 'ack', 'pushHint', 'pushText'] as const

/**
 * What the relay (and the receiving client) checks on a frame in clear: field shapes, the
 * nonce length, base64 ciphertext, TTL bounds, push fields only towards a phone, and the
 * 64 KiB frame budget (`tooLarge`).
 */
export function requireRelayFrame(value: unknown): RelayFrame {
  const f = requireRecord(value, 'RelayFrame')
  rejectUnknownKeys(f, RELAY_FRAME_KEYS, 'RelayFrame')
  const out: RelayFrame = {
    to: requireId(f.to, 'RelayFrame.to'),
    ref: requireId(f.ref, 'RelayFrame.ref'),
    nonce: requireBase64(f.nonce, 'RelayFrame.nonce', 24),
    ct: requireBase64(f.ct, 'RelayFrame.ct')
  }
  if (f.ttl !== undefined) out.ttl = requireTtl(f.ttl, 'RelayFrame.ttl')
  if (f.ack !== undefined) out.ack = requireId(f.ack, 'RelayFrame.ack')
  if (f.pushHint !== undefined) {
    if (out.to === 'desktop') invalid('pushHint is only for frames to a phone.')
    out.pushHint = requireNotificationCategory(f.pushHint, 'RelayFrame.pushHint')
  }
  if (f.pushText !== undefined) {
    if (out.to === 'desktop') invalid('pushText is only for frames to a phone.')
    if (typeof f.pushText !== 'string' || f.pushText.length > LIMITS.pushTextChars) invalid(`RelayFrame.pushText must be at most ${LIMITS.pushTextChars} characters.`)
    out.pushText = f.pushText as string
  }
  const bytes = utf8Bytes(JSON.stringify(value))
  if (bytes > LIMITS.frameBytes) invalid(`RelayFrame is ${bytes} bytes, above ${LIMITS.frameBytes}.`)
  return out
}

export function requireRelayClientFrame(value: unknown): RelayClientFrame {
  const f = requireRecord(value, 'RelayClientFrame')
  if ('pushToken' in f) {
    rejectUnknownKeys(f, ['pushToken'], 'RelayClientFrame')
    if (f.pushToken === null) return { pushToken: null }
    const token = requireId(f.pushToken, 'pushToken')
    if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,128}\]$/.test(token)) invalid('pushToken is not an Expo push token.')
    return { pushToken: token }
  }
  rejectUnknownKeys(f, ['auth'], 'RelayClientFrame')
  const a = requireRecord(f.auth, 'auth')
  const room = requireId(a.room, 'auth.room')
  if ('pairing' in a) {
    rejectUnknownKeys(a, ['room', 'pairing'], 'auth')
    return { auth: { room, pairing: requireId(a.pairing, 'auth.pairing') } }
  }
  if ('owner' in a) {
    rejectUnknownKeys(a, ['room', 'owner'], 'auth')
    return { auth: { room, owner: requireId(a.owner, 'auth.owner') } }
  }
  rejectUnknownKeys(a, ['room', 'device', 'token'], 'auth')
  return { auth: { room, device: requireId(a.device, 'auth.device'), token: requireId(a.token, 'auth.token') } }
}

export function requireRelayNotice(value: unknown): RelayNotice {
  const n = requireRecord(value, 'RelayNotice')
  if ('presence' in n) {
    rejectUnknownKeys(n, ['presence', 'since', 'queued'], 'RelayNotice')
    return { presence: requireOneOf(n.presence, ['online', 'offline'] as const, 'presence'), since: requireIsoDate(n.since, 'since'), queued: requireInteger(n.queued, 'queued', 0) }
  }
  if (n.queued === true) {
    rejectUnknownKeys(n, ['queued', 'ref'], 'RelayNotice')
    return { queued: true, ref: requireId(n.ref, 'ref') }
  }
  if (n.expired === true) {
    rejectUnknownKeys(n, ['expired', 'ref'], 'RelayNotice')
    return { expired: true, ref: requireId(n.ref, 'ref') }
  }
  if (n.tooLarge === true) {
    rejectUnknownKeys(n, ['tooLarge', 'ref', 'bytes'], 'RelayNotice')
    return { tooLarge: true, ref: requireId(n.ref, 'ref'), bytes: requireInteger(n.bytes, 'bytes', 0) }
  }
  return invalid('Unknown relay notice.')
}
