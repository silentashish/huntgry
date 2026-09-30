/**
 * Validation primitives shared by `guards.ts` (envelopes, commands, relay frames) and
 * `dto.ts` (event and result bodies): `ProtocolError`, the small `require*` building blocks
 * and the enum checks. Hand-written on purpose (ADR-0001 open question 10).
 */

import { LIMITS, utf8Bytes } from './limits'
import {
  NOTIFICATION_CATEGORIES,
  PROTOCOL,
  REMOTE_AGENT_IDS,
  REMOTE_DATE_STYLES,
  REMOTE_MAX_CONCURRENCY,
  type EnvelopeError,
  type EnvelopeErrorCode,
  type NotificationCategory,
  type ProtocolRange,
  type RemoteAgentId,
  type RemoteDateStyle,
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

/** What the phone is told when a command fails for a reason that is not a `ProtocolError`. */
export const GENERIC_FAILURE_MESSAGE = 'The command failed on your Mac. Check the desktop app and try again.'

/**
 * The `Envelope.error` to answer with for any thrown value. Only a `ProtocolError` carries
 * its message over the wire (they are written for the phone). Anything else — filesystem,
 * network or process errors, which may quote workspace paths or other local details — is
 * answered with `GENERIC_FAILURE_MESSAGE`; the caller keeps the original for its own log.
 */
export function errorOf(e: unknown): EnvelopeError {
  if (e instanceof ProtocolError) return { code: e.code, message: e.message }
  return { code: 'failed', message: GENERIC_FAILURE_MESSAGE }
}

export const invalid = (message: string): never => {
  throw new ProtocolError('invalid', message)
}

// ── primitives ──────────────────────────────────────────────────────────────────────────────

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function requireRecord(v: unknown, what: string): Record<string, unknown> {
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

export function requireStringArray(v: unknown, what: string, maxItems: number, maxChars: number = LIMITS.idChars): string[] {
  if (!Array.isArray(v) || v.length > maxItems) invalid(`${what} must be an array of at most ${maxItems} items.`)
  return (v as unknown[]).map((item, i) => requireId(item, `${what}[${i}]`, maxChars))
}

export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) invalid(`${what} has an unknown field "${key}".`)
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
export function requireBase64(v: unknown, what: string, bytes?: number): string {
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

