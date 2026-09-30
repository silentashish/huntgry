import { describe, expect, it } from 'vitest'
import {
  errorOf,
  isReadCommand,
  negotiateProtocol,
  ProtocolError,
  requireCommand,
  requireCommandEnvelope,
  requireEnvelope,
  requireEvent,
  requireFileChunk,
  requireFresh,
  requireHelloBody,
  requireNextSeq,
  requireRelayClientFrame,
  requireRelayFrame,
  requireRelayNotice,
  requireTtl,
  requireWorkspace,
  ttlFor
} from './guards'
import { LIMITS, TTL_SECONDS } from './limits'
import { COMMAND_TTL_SECONDS, REMOTE_COMMAND_NAMES, type Envelope } from './protocol'

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const base: Envelope = { v: 1, sid: 'sid-1', ws: 'ws-1', from: 'phone', seq: 3, ts: '2026-09-30T11:59:00.000Z', ttl: 86400, kind: 'cmd', id: 'c1', name: 'queue.get', body: {} }

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return errorOf(e).code
  }
  return 'ok'
}

describe('requireEnvelope', () => {
  it('accepts a well-formed command and strips nothing it knows', () => {
    expect(requireEnvelope(base)).toEqual(base)
    const result = { ...base, kind: 'result', re: 'c1', ok: false, error: { code: 'failed', message: 'x' }, id: undefined, name: undefined }
    delete (result as Partial<Envelope>).id
    delete (result as Partial<Envelope>).name
    expect(requireEnvelope(result)).toEqual(result)
  })

  it('rejects wrong shapes as invalid', () => {
    expect(codeOf(() => requireEnvelope(null))).toBe('invalid')
    expect(codeOf(() => requireEnvelope([]))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, extra: 1 }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, sid: '' }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, from: 'relay' }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, seq: 1.5 }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, seq: -1 }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, ts: 'yesterday' }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, kind: 'push' }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, id: undefined }))).toBe('invalid') // cmd without id
    expect(codeOf(() => requireEnvelope({ ...base, name: undefined }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, kind: 'result', ok: true }))).toBe('invalid') // no re
    expect(codeOf(() => requireEnvelope({ ...base, kind: 'result', re: 'c1', ok: false }))).toBe('invalid') // no error
    expect(codeOf(() => requireEnvelope({ ...base, kind: 'result', re: 'c1', ok: true, error: { code: 'nope', message: '' } }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, kind: 'event', name: undefined, id: undefined }))).toBe('invalid')
    const noBody: Record<string, unknown> = { ...base }
    delete noBody.body
    expect(codeOf(() => requireEnvelope(noBody))).toBe('invalid')
  })

  it('negotiates v / PROTOCOL: unknown majors are unsupported', () => {
    expect(codeOf(() => requireEnvelope({ ...base, v: 2 }))).toBe('unsupported')
    expect(codeOf(() => requireEnvelope({ ...base, v: 0 }))).toBe('unsupported')
    expect(codeOf(() => requireEnvelope({ ...base, v: '1' }))).toBe('invalid')
    expect(requireEnvelope({ ...base, v: 2 }, { protocol: { min: 1, max: 2 } }).v).toBe(2)
    expect(negotiateProtocol({ min: 1, max: 3 })).toBe(1)
    expect(negotiateProtocol({ min: 1, max: 1 }, { min: 1, max: 4 })).toBe(1)
    expect(negotiateProtocol({ min: 2, max: 3 }, { min: 1, max: 2 })).toBe(2)
    expect(codeOf(() => negotiateProtocol({ min: 2, max: 3 }))).toBe('unsupported')
    expect(codeOf(() => requireHelloBody({ protocol: { min: 1, max: 0 }, name: 'x', appVersion: '1' }))).toBe('invalid')
    expect(requireHelloBody({ protocol: { min: 1, max: 1 }, name: 'Mac', appVersion: '0.1.0', workspace: { id: 'w', name: 'n' } })).toEqual({
      protocol: { min: 1, max: 1 },
      name: 'Mac',
      appVersion: '0.1.0',
      workspace: { id: 'w', name: 'n' }
    })
  })

  it('binds frames to the session and the sender', () => {
    expect(codeOf(() => requireEnvelope(base, { sid: 'other' }))).toBe('denied')
    expect(codeOf(() => requireEnvelope(base, { from: 'desktop' }))).toBe('denied')
    expect(requireEnvelope(base, { sid: 'sid-1', from: 'phone' })).toEqual(base)
  })

  it('enforces ttl bounds', () => {
    expect(codeOf(() => requireEnvelope({ ...base, ttl: 0 }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, ttl: TTL_SECONDS.max + 1 }))).toBe('invalid')
    expect(codeOf(() => requireEnvelope({ ...base, ttl: 1.5 }))).toBe('invalid')
    expect(requireTtl(TTL_SECONDS.max)).toBe(TTL_SECONDS.max)
    expect(ttlFor('pipeline.start')).toBe(COMMAND_TTL_SECONDS.costly)
    expect(ttlFor('run.reply')).toBe(COMMAND_TTL_SECONDS.costly)
    expect(ttlFor('queue.get')).toBe(COMMAND_TTL_SECONDS.default)
    expect(ttlFor('queue.get', { costly: 10, default: 20 })).toBe(20)
  })

  it('rejects an envelope above the plaintext budget', () => {
    const big = { ...base, body: { text: 'x'.repeat(LIMITS.plaintextBytes) } }
    expect(codeOf(() => requireEnvelope(big))).toBe('invalid')
  })
})

describe('freshness and sequence', () => {
  it('now − ts ≤ ttl, with a little clock skew allowed', () => {
    expect(() => requireFresh({ ts: '2026-09-30T11:00:00.000Z', ttl: 3600 }, NOW)).not.toThrow()
    expect(codeOf(() => requireFresh({ ts: '2026-09-30T10:59:59.000Z', ttl: 3600 }, NOW))).toBe('expired')
    expect(() => requireFresh({ ts: '2026-09-30T12:04:00.000Z', ttl: 60 }, NOW)).not.toThrow()
    expect(codeOf(() => requireFresh({ ts: '2026-09-30T12:06:00.000Z', ttl: 60 }, NOW))).toBe('invalid')
  })

  it('seq must strictly increase; a rewound counter is denied', () => {
    expect(requireNextSeq(1, 0)).toBe(1)
    expect(requireNextSeq(10, 3)).toBe(10)
    expect(codeOf(() => requireNextSeq(3, 3))).toBe('denied')
    expect(codeOf(() => requireNextSeq(2, 3))).toBe('denied')
    expect(codeOf(() => requireNextSeq(-1, -2))).toBe('invalid')
    expect(codeOf(() => requireNextSeq(1.5, 0))).toBe('invalid')
  })
})

describe('workspace binding', () => {
  it('every command but status.get and device.* needs the current ws', () => {
    for (const name of REMOTE_COMMAND_NAMES) {
      const exempt = name === 'status.get' || name.startsWith('device.')
      expect(codeOf(() => requireWorkspace({ name, ws: undefined }, 'ws-1')), name).toBe(exempt ? 'ok' : 'invalid')
      expect(codeOf(() => requireWorkspace({ name, ws: 'ws-2' }, 'ws-1')), name).toBe(exempt ? 'ok' : 'invalid')
      expect(codeOf(() => requireWorkspace({ name, ws: 'ws-1' }, 'ws-1')), name).toBe('ok')
    }
  })
})

describe('requireCommand', () => {
  it('accepts every allow-listed name with valid arguments and returns only known fields', () => {
    const ok: Record<string, unknown> = {
      'status.get': undefined,
      'queue.get': {},
      'queue.setPaused': { paused: true },
      'queue.cancel': { itemId: 'q-1' },
      'queue.retry': { itemId: 'q-1' },
      'queue.enqueue': { jobIds: ['j1'], options: { coverLetter: true, dateStyle: 'inline', notes: 'hi' }, concurrency: 2, agent: 'codex' },
      'pipeline.start': { jobIds: ['j1', 'j2'], concurrency: 4, agent: 'claude', fallback: 'codex', budget: { maxCostUsd: 5, maxRuns: 3 } },
      'pipeline.pause': null,
      'pipeline.resume': {},
      'pipeline.stop': undefined,
      'jobs.list': { filter: 'saved', cursor: 'c' },
      'jobs.addUrl': { url: 'https://example.com/job/1' },
      'runs.list': {},
      'run.get': { runId: 'r1', sinceSeq: 20 },
      'run.reply': { runId: 'r1', text: 'yes' },
      'run.finish': { runId: 'r1' },
      'run.stop': { runId: 'r1' },
      'review.list': {},
      'review.get': { applicationId: 'a1' },
      'review.approve': { applicationId: 'a1', revision: 'r'.repeat(64), approvedReframingIds: ['x'] },
      'review.rerun': { runId: 'r1', revision: 'rev', answers: 'because' },
      'review.discard': { applicationId: 'a1', revision: 'rev' },
      'file.get': { applicationId: 'a1', file: 'resume-page-2.jpg', chunk: 0 },
      'device.setNotifications': { categories: ['needs-reply', 'failed'] }
    }
    expect(Object.keys(ok).sort()).toEqual([...REMOTE_COMMAND_NAMES].sort())
    for (const name of REMOTE_COMMAND_NAMES) {
      const cmd = requireCommand(name, ok[name])
      expect(cmd.name).toBe(name)
      if (ok[name] && Object.keys(ok[name] as object).length > 0) expect((cmd as { args: unknown }).args).toEqual(ok[name])
    }
    expect(requireCommand('run.get', { runId: 'r1' })).toEqual({ name: 'run.get', args: { runId: 'r1' } })
    expect(isReadCommand('run.get')).toBe(true)
    expect(isReadCommand('run.reply')).toBe(false)
  })

  it('unknown names are unsupported, never invalid', () => {
    for (const name of ['apply.start', 'browser.open', 'workspace.switch', 'runner.installClaude', 'applications.openFile', '', 42, null, 'queue.get ']) {
      expect(codeOf(() => requireCommand(name, {})), String(name)).toBe('unsupported')
    }
    expect(codeOf(() => requireCommandEnvelope({ ...base, name: 'nope' }))).toBe('unsupported')
    expect(codeOf(() => requireCommandEnvelope({ ...base, kind: 'event' }))).toBe('invalid')
    expect(requireCommandEnvelope({ ...base, name: 'queue.setPaused', body: { paused: false } })).toEqual({ name: 'queue.setPaused', args: { paused: false } })
  })

  it('rejects bad or extra arguments as invalid', () => {
    const bad: [string, unknown][] = [
      ['status.get', { x: 1 }],
      ['queue.setPaused', { paused: 'yes' }],
      ['queue.setPaused', { paused: true, force: true }],
      ['queue.cancel', {}],
      ['queue.cancel', { itemId: 'x'.repeat(LIMITS.idChars + 1) }],
      ['queue.enqueue', { jobIds: [], options: { coverLetter: true, dateStyle: 'inline' } }],
      ['queue.enqueue', { jobIds: Array.from({ length: 101 }, (_, i) => `j${i}`), options: { coverLetter: true, dateStyle: 'inline' } }],
      ['queue.enqueue', { jobIds: ['j'], options: { coverLetter: true, dateStyle: 'center' } }],
      ['queue.enqueue', { jobIds: ['j'], options: { coverLetter: true, dateStyle: 'inline' }, concurrency: 5 }],
      ['queue.enqueue', { jobIds: ['j'], options: { coverLetter: true, dateStyle: 'inline' }, concurrency: 0 }],
      ['queue.enqueue', { jobIds: ['j'], options: { coverLetter: true, dateStyle: 'inline' }, agent: 'gpt' }],
      ['queue.enqueue', { jobIds: ['j'], options: { coverLetter: true, dateStyle: 'inline', jobDescription: 'pasted' } }],
      ['pipeline.start', { jobIds: ['j'], concurrency: 2, agent: 'claude', fallback: 'claude' }],
      ['pipeline.start', { jobIds: ['j'], concurrency: 2, agent: 'claude', model: 'opus' }],
      ['pipeline.start', { jobIds: ['j'], agent: 'claude' }],
      ['jobs.addUrl', { url: 'file:///etc/passwd' }],
      ['jobs.addUrl', { url: 'ftp://x' }],
      ['run.get', { runId: 'r', sinceSeq: -1 }],
      ['run.reply', { runId: 'r', text: '   ' }],
      ['run.reply', { runId: 'r', text: 42 }],
      ['review.approve', { applicationId: 'a', revision: 'r', approvedReframingIds: 'x' }],
      ['review.approve', { applicationId: 'a' }],
      ['file.get', { applicationId: 'a', file: '../master-profile.md', chunk: 0 }],
      ['file.get', { applicationId: 'a', file: 'resume.pdf', chunk: -1 }],
      ['file.get', { applicationId: 'a', file: 'resume-page-x.jpg', chunk: 0 }],
      ['device.setNotifications', { categories: ['all'] }],
      ['device.setNotifications', { categories: ['failed', 'failed'] }],
      ['device.setNotifications', { categories: 'failed' }]
    ]
    for (const [name, args] of bad) expect(codeOf(() => requireCommand(name, args)), `${name} ${JSON.stringify(args)}`).toBe('invalid')
  })

  it('caps text fields at LIMITS.textBytes in bytes', () => {
    const max = 'é'.repeat(LIMITS.textBytes / 2) // exactly 32 KiB of UTF-8
    expect(requireCommand('run.reply', { runId: 'r', text: max })).toEqual({ name: 'run.reply', args: { runId: 'r', text: max } })
    expect(codeOf(() => requireCommand('run.reply', { runId: 'r', text: max + 'a' }))).toBe('invalid')
    expect(codeOf(() => requireCommand('review.rerun', { runId: 'r', revision: 'v', answers: max + 'a' }))).toBe('invalid')
    expect(codeOf(() => requireCommand('queue.enqueue', { jobIds: ['j'], options: { coverLetter: false, dateStyle: 'right', notes: max + 'a' } }))).toBe('invalid')
  })
})

describe('events and file chunks', () => {
  const chunk = { applicationId: 'a', file: 'resume.pdf', chunk: 1, of: 3, bytes: 60000, sha256: 'a'.repeat(64), data: Buffer.alloc(LIMITS.fileChunkBytes, 1).toString('base64') }

  it('accepts a full-size chunk and rejects the first larger one', () => {
    expect(requireFileChunk(chunk)).toEqual(chunk)
    expect(requireEvent('file.chunk', chunk)).toEqual({ name: 'file.chunk', body: chunk })
    const bigger = { ...chunk, data: Buffer.alloc(LIMITS.fileChunkBytes + 1, 1).toString('base64') }
    expect(codeOf(() => requireFileChunk(bigger))).toBe('invalid')
    expect(codeOf(() => requireFileChunk({ ...chunk, chunk: 3 }))).toBe('invalid')
    expect(codeOf(() => requireFileChunk({ ...chunk, sha256: 'xyz' }))).toBe('invalid')
    expect(codeOf(() => requireFileChunk({ ...chunk, data: 'not base64!' }))).toBe('invalid')
    expect(codeOf(() => requireFileChunk({ ...chunk, file: 'master-profile.md' }))).toBe('invalid')
  })

  it('knows the event allow-list', () => {
    expect(requireEvent('status', { desktop: {} })).toEqual({ name: 'status', body: { desktop: {} } })
    expect(requireEvent('device.revoked', { reason: 'unpaired' })).toEqual({ name: 'device.revoked', body: { reason: 'unpaired' } })
    expect(requireEvent('applications.changed', { ids: ['a'] })).toEqual({ name: 'applications.changed', body: { ids: ['a'] } })
    expect(codeOf(() => requireEvent('runner:event', {}))).toBe('unsupported')
    expect(codeOf(() => requireEvent('status', 'x'))).toBe('invalid')
    expect(codeOf(() => requireEvent('applications.changed', { ids: 'a' }))).toBe('invalid')
  })
})

describe('relay layer', () => {
  const nonce = Buffer.alloc(24, 7).toString('base64')
  const frame = { to: 'desktop', ref: 'c1', nonce, ct: 'AAAA', ttl: 7200, ack: 'r9' }

  it('checks a RelayFrame in clear', () => {
    expect(requireRelayFrame(frame)).toEqual(frame)
    expect(requireRelayFrame({ to: 'dev-1', ref: 'e1', nonce, ct: 'AAAA', pushHint: 'needs-reply', pushText: 'Backend · Acme' })).toMatchObject({ pushHint: 'needs-reply' })
    expect(codeOf(() => requireRelayFrame({ ...frame, nonce: 'AAAA' }))).toBe('invalid')
    expect(codeOf(() => requireRelayFrame({ ...frame, ct: '***' }))).toBe('invalid')
    expect(codeOf(() => requireRelayFrame({ ...frame, ttl: 0 }))).toBe('invalid')
    expect(codeOf(() => requireRelayFrame({ ...frame, pushHint: 'needs-reply' }))).toBe('invalid') // not towards a phone
    expect(codeOf(() => requireRelayFrame({ ...frame, to: 'dev-1', pushHint: 'spam' }))).toBe('invalid')
    expect(codeOf(() => requireRelayFrame({ ...frame, to: 'dev-1', pushText: 'x'.repeat(81) }))).toBe('invalid')
    expect(codeOf(() => requireRelayFrame({ ...frame, body: {} }))).toBe('invalid')
    const huge = { ...frame, ct: 'A'.repeat(LIMITS.frameBytes) }
    expect(codeOf(() => requireRelayFrame(huge))).toBe('invalid')
  })

  it('checks client auth frames and the push token', () => {
    expect(requireRelayClientFrame({ auth: { room: 'r', pairing: 'p' } })).toEqual({ auth: { room: 'r', pairing: 'p' } })
    expect(requireRelayClientFrame({ auth: { room: 'r', device: 'd', token: 't' } })).toEqual({ auth: { room: 'r', device: 'd', token: 't' } })
    expect(requireRelayClientFrame({ auth: { room: 'r', owner: 'o' } })).toEqual({ auth: { room: 'r', owner: 'o' } })
    expect(requireRelayClientFrame({ pushToken: null })).toEqual({ pushToken: null })
    expect(requireRelayClientFrame({ pushToken: 'ExponentPushToken[abc-DEF_123]' })).toEqual({ pushToken: 'ExponentPushToken[abc-DEF_123]' })
    expect(codeOf(() => requireRelayClientFrame({ pushToken: 'abc' }))).toBe('invalid')
    expect(codeOf(() => requireRelayClientFrame({ auth: { room: 'r' } }))).toBe('invalid')
    expect(codeOf(() => requireRelayClientFrame({ auth: { room: 'r', owner: 'o', device: 'd' } }))).toBe('invalid')
    expect(codeOf(() => requireRelayClientFrame({ hello: 1 }))).toBe('invalid')
  })

  it('checks relay notices', () => {
    expect(requireRelayNotice({ presence: 'online', since: '2026-09-30T00:00:00Z', queued: 2 })).toEqual({ presence: 'online', since: '2026-09-30T00:00:00Z', queued: 2 })
    expect(requireRelayNotice({ queued: true, ref: 'c' })).toEqual({ queued: true, ref: 'c' })
    expect(requireRelayNotice({ expired: true, ref: 'c' })).toEqual({ expired: true, ref: 'c' })
    expect(requireRelayNotice({ tooLarge: true, ref: 'c', bytes: 70000 })).toEqual({ tooLarge: true, ref: 'c', bytes: 70000 })
    expect(codeOf(() => requireRelayNotice({ presence: 'away', since: '2026-09-30T00:00:00Z', queued: 0 }))).toBe('invalid')
    expect(codeOf(() => requireRelayNotice({ queued: 1, ref: 'c' }))).toBe('invalid')
  })
})

describe('errorOf', () => {
  it('maps ProtocolError codes and wraps anything else as failed', () => {
    expect(errorOf(new ProtocolError('stale', 'changed'))).toEqual({ code: 'stale', message: 'changed' })
    expect(errorOf(new Error('boom'))).toEqual({ code: 'failed', message: 'boom' })
    expect(errorOf('x')).toEqual({ code: 'failed', message: 'x' })
  })
})
