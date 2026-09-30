import { writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { deriveSessionKey, generateKeyPair, openEnvelope, sealEnvelope, toBase64 } from './crypto'
import { requireCommand, requireEnvelope, requireEvent, requireFileChunk, requireRelayFrame, ttlFor } from './guards'
import { jsonBytes, LIMITS } from './limits'
import {
  COMMAND_TTL_SECONDS,
  COSTLY_COMMANDS,
  REMOTE_COMMAND_NAMES,
  REMOTE_EVENT_NAMES,
  type Envelope,
  type PipelineState,
  type RelayFrame,
  type RemoteCommand,
  type RemoteCommandName,
  type RemoteEvent,
  type RemoteEventName,
  type RemoteQueueItem,
  type RemoteRun,
  type RemoteTranscriptItem,
  type ReviewDetail,
  type StatusSummary
} from './protocol'

/**
 * ADR-0001 "Size limits": every command and event, built with its largest allowed fields,
 * goes through the real box + base64 path and the serialised RelayFrame stays under 64 KiB.
 * The first payload above a limit is rejected by the guard before it is encrypted.
 */

/** Frame bytes per payload, written to `FRAME_SIZES=<file>` when set (the README table comes from here). */
const sizes: Record<string, number> = {}
afterAll(() => {
  if (process.env.FRAME_SIZES) writeFileSync(process.env.FRAME_SIZES, JSON.stringify(sizes, null, 2))
})

const desktop = generateKeyPair()
const phone = generateKeyPair()
const phoneKey = deriveSessionKey(desktop.publicKey, phone.secretKey)
const desktopKey = deriveSessionKey(phone.publicKey, desktop.secretKey)

const ID = 'x'.repeat(LIMITS.idChars) // the longest id the guards accept
const APP_ID = 'a'.repeat(LIMITS.applicationIdChars)
const CURSOR = 'c'.repeat(LIMITS.cursorChars)
const TITLE = 't'.repeat(LIMITS.titleChars)
const TEXT_MAX = 'é'.repeat(LIMITS.textBytes / 2) // exactly LIMITS.textBytes of UTF-8
const ISO = '2026-09-30T12:00:00.000Z'
const SHA = 'f'.repeat(64)
const HUNDRED_IDS = Array.from({ length: 100 }, (_, i) => `url:${String(i).padStart(3, '0')}${'y'.repeat(LIMITS.jobIdChars - 7)}`)

function frameFor(envelope: Envelope, key: Uint8Array, to: string): RelayFrame {
  const { nonce, ct } = sealEnvelope(envelope, key, undefined)
  return { to, ref: envelope.id ?? ID, nonce, ct, ttl: envelope.ttl, ack: ID, ...(to !== 'desktop' ? { pushHint: 'pipeline-finished', pushText: 'p'.repeat(LIMITS.pushTextChars) } : {}) }
}

/** Sends an envelope through the whole path and returns the frame size in bytes. */
function roundTrip(envelope: Envelope, from: 'phone' | 'desktop'): number {
  const sendKey = from === 'phone' ? phoneKey : desktopKey
  const receiveKey = from === 'phone' ? desktopKey : phoneKey
  requireEnvelope(envelope)
  const frame = frameFor(envelope, sendKey, from === 'phone' ? 'desktop' : ID)
  const bytes = jsonBytes(frame)
  expect(bytes, `${envelope.name} frame`).toBeLessThan(LIMITS.frameBytes)
  requireRelayFrame(JSON.parse(JSON.stringify(frame)))
  const opened = openEnvelope(frame, receiveKey)
  expect(requireEnvelope(opened)).toEqual(envelope)
  return bytes
}

const largestArgs: Record<RemoteCommandName, unknown> = {
  'status.get': undefined,
  'queue.get': undefined,
  'queue.setPaused': { paused: true },
  'queue.cancel': { itemId: ID },
  'queue.retry': { itemId: ID },
  'queue.enqueue': { jobIds: HUNDRED_IDS, options: { coverLetter: true, dateStyle: 'inline', notes: TEXT_MAX }, concurrency: 4, agent: 'antigravity' },
  'pipeline.start': { jobIds: HUNDRED_IDS, concurrency: 4, agent: 'claude', fallback: 'codex', budget: { maxCostUsd: 1e6, maxRuns: 100 }, options: { coverLetter: true, dateStyle: 'right' } },
  'pipeline.pause': undefined,
  'pipeline.resume': undefined,
  'pipeline.stop': undefined,
  'jobs.list': { filter: ID, cursor: CURSOR },
  'jobs.addUrl': { url: `https://example.com/${'u'.repeat(LIMITS.shortStringChars - 20)}` },
  'runs.list': { cursor: CURSOR },
  'run.get': { runId: ID, sinceSeq: Number.MAX_SAFE_INTEGER },
  'run.reply': { runId: ID, text: TEXT_MAX },
  'run.finish': { runId: ID },
  'run.stop': { runId: ID },
  'review.list': undefined,
  'review.get': { applicationId: APP_ID },
  'review.approve': { applicationId: APP_ID, revision: 'r'.repeat(128), approvedReframingIds: Array.from({ length: 200 }, () => SHA) },
  'review.rerun': { runId: ID, revision: 'r'.repeat(128), answers: TEXT_MAX },
  'review.discard': { applicationId: APP_ID, revision: 'r'.repeat(128) },
  'file.get': { applicationId: APP_ID, file: 'cover-page-9999.jpg', chunk: 100_000 },
  'device.setNotifications': { categories: ['needs-reply', 'usage-limit', 'pipeline-finished', 'needs-review', 'failed'] }
}

describe('every command with its largest fields fits one frame', () => {
  for (const name of REMOTE_COMMAND_NAMES) {
    it(name, () => {
      const cmd = requireCommand(name, largestArgs[name]) as RemoteCommand & { args?: unknown }
      const envelope: Envelope = { v: 1, sid: ID, ws: ID, from: 'phone', seq: Number.MAX_SAFE_INTEGER, ts: ISO, ttl: ttlFor(name), kind: 'cmd', id: ID, name, body: cmd.args ?? null }
      const bytes = roundTrip(envelope, 'phone')
      expect(jsonBytes(envelope)).toBeLessThanOrEqual(LIMITS.plaintextBytes)
      expect(envelope.ttl).toBe((COSTLY_COMMANDS as readonly string[]).includes(name) ? COMMAND_TTL_SECONDS.costly : COMMAND_TTL_SECONDS.default)
      sizes[name] = bytes
    })
  }

  it('rejects the first reply / answers / notes above LIMITS.textBytes before encrypting', () => {
    const over = TEXT_MAX + 'a'
    expect(() => requireCommand('run.reply', { runId: ID, text: over })).toThrow(/exceeds/)
    expect(() => requireCommand('review.rerun', { runId: ID, revision: 'v', answers: over })).toThrow(/exceeds/)
    expect(() => requireCommand('queue.enqueue', { jobIds: ['j'], options: { coverLetter: true, dateStyle: 'inline', notes: over } })).toThrow(/exceeds/)
  })
})

// ── events ──────────────────────────────────────────────────────────────────────────────────

const errorMax = 'e'.repeat(LIMITS.errorBytes)
const run: RemoteRun = {
  id: ID,
  title: TITLE,
  agent: 'antigravity',
  status: 'finished',
  job: { company: 'c'.repeat(200), role: 'r'.repeat(200), jobId: ID, source: 'hiring.cafe' },
  options: { coverLetter: true, dateStyle: 'inline' },
  createdAt: ISO,
  updatedAt: ISO,
  files: ['resume.pdf', 'cover.pdf'],
  costUsd: 123.456789,
  usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER },
  live: true,
  error: errorMax
}
const queueItem: RemoteQueueItem = {
  id: ID,
  jobId: 'j'.repeat(LIMITS.jobIdChars),
  title: TITLE,
  agent: 'antigravity',
  status: 'needs-reply',
  runId: ID,
  error: errorMax,
  attempts: 99,
  built: true,
  hasPendingReply: true,
  notBefore: ISO,
  createdAt: ISO,
  updatedAt: ISO
}
const transcriptText = 'w'.repeat(LIMITS.transcriptItemTextBytes)
const transcriptItems: RemoteTranscriptItem[] = Array.from({ length: LIMITS.transcriptPageItems }, (_, i): RemoteTranscriptItem =>
  i % 3 === 0
    ? { kind: 'tool', id: `${i}`, name: 'Bash', summary: 's'.repeat(200), status: 'ok', output: transcriptText, truncated: true }
    : i % 3 === 1
      ? { kind: 'assistant', id: `${i}`, text: transcriptText, truncated: true }
      : { kind: 'result', id: `${i}`, ok: true, text: transcriptText, costUsd: 1, durationMs: 1e9, denials: Array.from({ length: 10 }, () => 'd'.repeat(80)), usage: { inputTokens: 1e9, outputTokens: 1e9 } }
)
const status: StatusSummary = {
  desktop: { name: 'n'.repeat(200), appVersion: '0.1.0', workspaceName: 'w'.repeat(200), workspaceId: ID },
  queue: { active: 4, needsReply: 100, failed: 100, paused: false },
  pipeline: { status: 'waiting-limit', until: ISO },
  review: { unreviewed: 100 },
  agents: [
    { id: 'claude', ready: true },
    { id: 'codex', ready: false },
    { id: 'antigravity', ready: true }
  ]
}
const pipeline: PipelineState = { status: 'running', agent: 'claude', counts: { total: 100, done: 50, running: 4, queued: 40, failed: 6, unreviewed: 50 }, waitingLimitUntil: ISO, eta: ISO, startedAt: ISO, updatedAt: ISO }
const review: ReviewDetail = {
  applicationId: APP_ID,
  runId: ID,
  title: TITLE,
  reviewNotes: 'n'.repeat(LIMITS.reviewNotesInlineBytes),
  openGaps: Array.from({ length: 20 }, () => 'g'.repeat(200)),
  proposedReframings: Array.from({ length: 20 }, () => ({ id: SHA, sourceFact: 'f'.repeat(200), wording: 'w'.repeat(200) })),
  verify: { ok: false, report: 'r'.repeat(4096) },
  artifacts: Array.from({ length: 12 }, (_, i) => ({ file: i === 0 ? 'resume.pdf' : `resume-page-${i}.jpg`, bytes: 1e7, sha256: SHA })),
  revision: SHA
}
const chunkData = toBase64(new Uint8Array(LIMITS.fileChunkBytes).fill(255))

const largestBodies: Record<RemoteEventName, unknown> = {
  status,
  'queue.changed': { items: Array.from({ length: LIMITS.queueItems }, () => queueItem), concurrency: 4, paused: true, more: 70 },
  'run.changed': run,
  'run.transcript': { runId: ID, items: transcriptItems.slice(0, 4), seq: Number.MAX_SAFE_INTEGER },
  'pipeline.changed': pipeline,
  'pipeline.finished': { status: 'budget', counts: pipeline.counts, costUsd: 1e6, startedAt: ISO, finishedAt: ISO },
  'review.needed': { count: 100, latest: { applicationId: APP_ID, runId: ID, title: TITLE, openGaps: 20, finishedAt: ISO } },
  'applications.changed': { ids: Array.from({ length: LIMITS.applicationsChangedIds }, () => APP_ID) },
  'file.chunk': { applicationId: APP_ID, file: 'cover-page-9999.jpg', chunk: 99_999, of: 100_000, bytes: 2 ** 31, sha256: SHA, data: chunkData },
  'device.revoked': { reason: 'r'.repeat(LIMITS.shortStringChars) }
}

describe('every event with its largest fields fits one frame', () => {
  for (const name of REMOTE_EVENT_NAMES) {
    it(name, () => {
      const event = requireEvent(name, largestBodies[name]) as RemoteEvent
      const envelope: Envelope = { v: 1, sid: ID, from: 'desktop', seq: Number.MAX_SAFE_INTEGER, ts: ISO, ttl: COMMAND_TTL_SECONDS.default, kind: 'event', name, body: event.body }
      expect(jsonBytes(envelope), `${name} plaintext`).toBeLessThanOrEqual(LIMITS.plaintextBytes)
      sizes[`event ${name}`] = roundTrip(envelope, 'desktop')
    })
  }

  it('a 24 KiB chunk is the largest that passes; one more byte is rejected', () => {
    const body = largestBodies['file.chunk'] as Record<string, unknown>
    expect(requireFileChunk(body)).toEqual(body)
    expect(() => requireFileChunk({ ...body, data: toBase64(new Uint8Array(LIMITS.fileChunkBytes + 1)) })).toThrow(/exceeds/)
  })

  it('a review detail with 16 KiB inline notes and a 32 KiB reply result both fit', () => {
    const detail: Envelope = { v: 1, sid: ID, from: 'desktop', seq: 1, ts: ISO, ttl: 60, kind: 'result', re: ID, ok: true, body: review }
    sizes['result review.get'] = roundTrip(detail, 'desktop')
    const page: Envelope = { v: 1, sid: ID, from: 'desktop', seq: 2, ts: ISO, ttl: 60, kind: 'result', re: ID, ok: true, body: { run, items: transcriptItems.slice(0, 4), nextSeq: 1e9 } }
    sizes['result run.get'] = roundTrip(page, 'desktop')
    const reply: Envelope = { v: 1, sid: ID, from: 'desktop', seq: 3, ts: ISO, ttl: 60, kind: 'result', re: ID, ok: false, error: { code: 'failed', message: 'm'.repeat(LIMITS.shortStringChars) }, body: { text: TEXT_MAX } }
    roundTrip(reply, 'desktop')
  })

  it('a full transcript page of 20 × 8 KiB items does not fit one frame: the projector must page by bytes too', () => {
    // Documented in the README: run.get pages by LIMITS.transcriptPageItems *and* the plaintext budget.
    const envelope: Envelope = { v: 1, sid: ID, from: 'desktop', seq: 1, ts: ISO, ttl: 60, kind: 'event', name: 'run.transcript', body: { runId: ID, items: transcriptItems, seq: 1 } }
    expect(jsonBytes(envelope)).toBeGreaterThan(LIMITS.plaintextBytes)
    expect(() => requireEnvelope(envelope)).toThrow(/exceeds/)
  })
})
