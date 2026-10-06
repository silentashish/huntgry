import { randomUUID } from 'node:crypto'
import type { Job } from '@shared/jobs-types'
import type { QueueState } from '@shared/queue-types'
import type { RunSummary } from '@shared/runner-types'
import { deriveSessionKey, generateKeyPair, toBase64, ttlFor, type Envelope, type KeyPair, type RemoteCommandName } from '@shared/remote'
import type { Cipher } from './credentials'
import type { DeviceRecord } from './devices'

/** A reversible stand-in for `safeStorage` (XOR with a fixed key, base64) — tests only. */
export const fakeCipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (blob) => Buffer.from(blob.map((b) => b ^ 0x5a)).toString('utf8')
})

/** A cipher whose decryption always fails (Keychain reset). */
export const brokenCipher = (): Cipher => ({
  available: () => true,
  encrypt: (text) => Buffer.from(text),
  decrypt: () => {
    throw new Error('decryption failed')
  }
})

export interface FakePhone {
  id: string
  keys: KeyPair
  sid: string
  sessionKey: Uint8Array
  seq: number
  record: DeviceRecord
}

/** A paired phone: its keypair, the device record the desktop holds, and the shared session key. */
export function fakePhone(desktop: KeyPair, name = 'Test iPhone', id = `dev-${randomUUID().slice(0, 8)}`): FakePhone {
  const keys = generateKeyPair()
  const sid = `sid-${randomUUID().slice(0, 8)}`
  return {
    id,
    keys,
    sid,
    sessionKey: deriveSessionKey(desktop.publicKey, keys.secretKey),
    seq: 0,
    record: {
      id,
      name,
      publicKey: toBase64(keys.publicKey),
      tokenHash: 'a'.repeat(64),
      sid,
      pairedAt: '2026-09-30T00:00:00.000Z',
      lastSeq: 0,
      categories: [],
      needsRepair: false
    }
  }
}

/** A command envelope from the phone with the next `seq`. */
export function command(phone: FakePhone, name: RemoteCommandName, args: unknown, ws: string | undefined, over: Partial<Envelope> = {}): Envelope {
  phone.seq++
  const env: Envelope = {
    v: 1,
    sid: phone.sid,
    from: 'phone',
    seq: phone.seq,
    ts: new Date().toISOString(),
    ttl: ttlFor(name),
    kind: 'cmd',
    id: randomUUID(),
    name,
    body: args ?? null,
    ...over
  }
  if (ws !== undefined) env.ws = ws
  return env
}

export function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: '20260930-010203-a1b2c3',
    title: 'Engineer · Acme',
    params: { jobDescription: 'MARKER_JOB_DESCRIPTION', jobUrl: 'https://MARKER_URL.example', notes: 'MARKER_NOTES', company: 'Acme', role: 'Engineer', jobId: '42', source: 'url', coverLetter: true, dateStyle: 'inline' },
    agent: 'claude',
    status: 'waiting',
    sessionId: 'MARKER_SESSION',
    createdAt: '2026-09-30T01:02:03.000Z',
    updatedAt: '2026-09-30T01:02:04.000Z',
    outputFolder: 'MARKER_OUTPUT_FOLDER/acme/42',
    outputFiles: ['resume.pdf', 'MARKER_FILE.tex'],
    costUsd: 0.5,
    live: true,
    ...over
  }
}

export function queueState(over: Partial<QueueState> = {}): QueueState {
  return {
    items: [
      {
        id: 'q-20260930-010203-a1b2c3',
        jobId: 'url:abc123',
        title: 'Engineer · Acme',
        options: { coverLetter: false, dateStyle: 'right', notes: 'MARKER_NOTES' },
        agent: 'claude',
        status: 'queued',
        runId: null,
        attempts: 0,
        pendingReply: 'MARKER_PENDING_REPLY',
        createdAt: '2026-09-30T01:02:03.000Z',
        updatedAt: '2026-09-30T01:02:03.000Z'
      }
    ],
    concurrency: 2,
    paused: false,
    ...over
  }
}

export function job(id: string, over: Partial<Job> = {}): Job {
  const [source, sourceId] = id.split(':') as [Job['source'], string]
  return {
    id,
    source,
    sourceId,
    title: `Engineer ${sourceId}`,
    company: `Co ${sourceId}`,
    location: 'Remote',
    remote: true,
    salary: '',
    postedAt: null,
    url: `https://jobs.example.com/${sourceId}`,
    boardUrl: null,
    description: 'MARKER_DESCRIPTION Build APIs.',
    descriptionComplete: true,
    tags: [],
    fetchedAt: '2026-09-30T00:00:00.000Z',
    ...over
  }
}
