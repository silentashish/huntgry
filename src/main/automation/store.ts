import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AUTOMATION_STEPS,
  EMPTY_AUTOMATION_STATE,
  type AutomationCandidate,
  type AutomationLogEntry,
  type AutomationRun,
  type AutomationState,
  type PreparedFill
} from '@shared/automation-types'
import { HUNTGRY_DIR } from '../workspace/constants'
import type { TrustedUsage } from './service'

/**
 * Automation's files in the workspace (#154):
 * - `.huntgry/automation.json`: the state (candidates and their steps, the run, today's count), versioned,
 *   written whole through a temp file, one write at a time per workspace;
 * - `.huntgry/automation-log.jsonl`: every step's start, ok, skip and fail, appended; a torn last line (a
 *   crash mid-append) is skipped on read and never glued to the next entry;
 * - `.huntgry/automation/prepared/<slug>.json`: the prepared fill of each Ready to submit job.
 * Settings and caps are not here: they live in userData (`settings.ts`).
 */

export const STATE_FILE = 'automation.json'
export const LOG_FILE = 'automation-log.jsonl'

export const stateFile = (ws: string): string => join(ws, HUNTGRY_DIR, STATE_FILE)
export const logFile = (ws: string): string => join(ws, HUNTGRY_DIR, LOG_FILE)
export const preparedDir = (ws: string): string => join(ws, HUNTGRY_DIR, 'automation', 'prepared')
/** The application id `<role>/<company>/<job-id>` as one safe file name. */
export const preparedFile = (ws: string, applicationId: string): string =>
  join(preparedDir(ws), `${applicationId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200)}.json`)

const STEPS = new Set<string>(AUTOMATION_STEPS)
const RUN_STATUSES = new Set(['running', 'paused', 'waiting', 'stopped-cost', 'stopped-cap', 'stopped', 'finished'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function normalizeRun(v: unknown): AutomationRun | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.startedAt !== 'string' || !RUN_STATUSES.has(v.status as string)) return null
  return {
    id: v.id,
    startedAt: v.startedAt,
    ...(str(v.endedAt) ? { endedAt: str(v.endedAt) } : {}),
    status: v.status as AutomationRun['status'],
    trigger: v.trigger === 'window' ? 'window' : 'now',
    ...(str(v.message) ? { message: str(v.message) } : {}),
    costUsd: num(v.costUsd) ?? 0,
    pageLoads: num(v.pageLoads) ?? 0,
    candidates: Array.isArray(v.candidates) ? v.candidates.filter((k): k is string => typeof k === 'string') : [],
    ...(str(v.current) ? { current: str(v.current) } : {})
  }
}

function normalizeCandidate(v: unknown): AutomationCandidate | null {
  if (!isObject(v) || typeof v.key !== 'string' || !STEPS.has(v.step as string)) return null
  const c = v as unknown as AutomationCandidate
  return {
    ...c,
    title: str(v.title) ?? '',
    company: str(v.company) ?? '',
    reasons: Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string') : [],
    updatedAt: str(v.updatedAt) ?? new Date(0).toISOString()
  }
}

/** The state file, checked again on read (it is in the user's folder); anything unreadable starts empty. */
export function normalizeState(raw: unknown): AutomationState {
  if (!isObject(raw) || raw.version !== 1) return structuredClone(EMPTY_AUTOMATION_STATE)
  const candidates: Record<string, AutomationCandidate> = {}
  if (isObject(raw.candidates)) {
    for (const v of Object.values(raw.candidates)) {
      const c = normalizeCandidate(v)
      if (c) candidates[c.key] = c
    }
  }
  const day = isObject(raw.day) ? raw.day : {}
  return {
    version: 1,
    enabled: raw.enabled === true,
    paused: raw.paused === true,
    nextWindowAt: str(raw.nextWindowAt) ?? null,
    run: normalizeRun(raw.run),
    lastRun: normalizeRun(raw.lastRun),
    candidates,
    day: { date: str(day.date) ?? '', started: Math.max(0, Math.floor(num(day.started) ?? 0)) }
  }
}

export async function readState(ws: string): Promise<AutomationState> {
  try {
    return normalizeState(JSON.parse(await readFile(stateFile(ws), 'utf8')))
  } catch {
    return structuredClone(EMPTY_AUTOMATION_STATE)
  }
}

const writes = new Map<string, Promise<unknown>>()

/** Writes the whole state through a temp file; writes to one workspace go one after another. */
export function writeState(ws: string, state: AutomationState): Promise<void> {
  const body = `${JSON.stringify(state, null, 2)}\n`
  const run = (writes.get(ws) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await mkdir(join(ws, HUNTGRY_DIR), { recursive: true })
      const tmp = `${stateFile(ws)}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, stateFile(ws))
    })
  writes.set(ws, run)
  // Both ways: a cleanup chained with `finally` alone would reject again, unhandled, when the write fails.
  const forget = () => {
    if (writes.get(ws) === run) writes.delete(ws)
  }
  run.then(forget, forget)
  return run
}

/** Waits for the pending state writes of `ws` (tests, quit). */
export async function flushState(ws: string): Promise<void> {
  await writes.get(ws)?.catch(() => undefined)
}

const appends = new Map<string, Promise<unknown>>()

/** Whether the log's last byte is a newline (or the file is empty or missing). */
async function endsClean(file: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    if (size === 0) return true
    const buf = Buffer.alloc(1)
    await handle.read(buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } catch {
    return true
  } finally {
    await handle?.close()
  }
}

/** Appends one log line; a torn last line left by a crash is closed first so the new entry stays readable. */
export function appendLog(ws: string, entry: AutomationLogEntry): Promise<void> {
  const run = (appends.get(ws) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await mkdir(join(ws, HUNTGRY_DIR), { recursive: true })
      const file = logFile(ws)
      const prefix = (await endsClean(file)) ? '' : '\n'
      await appendFile(file, `${prefix}${JSON.stringify(entry)}\n`, 'utf8')
    })
  appends.set(ws, run)
  const forget = () => {
    if (appends.get(ws) === run) appends.delete(ws)
  }
  run.then(forget, forget)
  return run
}

function parseEntry(line: string): AutomationLogEntry | null {
  try {
    const e: unknown = JSON.parse(line)
    if (!isObject(e) || typeof e.at !== 'string' || typeof e.message !== 'string' || typeof e.step !== 'string') return null
    return e as unknown as AutomationLogEntry
  } catch {
    return null
  }
}

/** The latest `limit` entries, newest first, optionally of one candidate. Unreadable lines are skipped. */
export async function readLog(ws: string, { limit = 200, key }: { limit?: number; key?: string } = {}): Promise<AutomationLogEntry[]> {
  await appends.get(ws)?.catch(() => undefined)
  let text: string
  try {
    text = await readFile(logFile(ws), 'utf8')
  } catch {
    return []
  }
  const out: AutomationLogEntry[] = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    const e = parseEntry(line)
    if (e && (key === undefined || e.key === key)) out.push(e)
  }
  return out
}

export async function writePrepared(ws: string, fill: PreparedFill): Promise<void> {
  await mkdir(preparedDir(ws), { recursive: true })
  const file = preparedFile(ws, fill.applicationId)
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(fill, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** The prepared fill of an application, or `null` (none, unreadable, or another application's). */
export async function readPrepared(ws: string, applicationId: string): Promise<PreparedFill | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(preparedFile(ws, applicationId), 'utf8'))
    if (!isObject(raw) || raw.version !== 1 || raw.applicationId !== applicationId || !isObject(raw.report)) return null
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
    const record = (v: unknown) => (isObject(v) ? v : {})
    return {
      version: 1,
      applicationId,
      url: str(raw.url) ?? '',
      report: raw.report as unknown as PreparedFill['report'],
      drafts: Object.fromEntries(Object.entries(record(raw.drafts)).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
      aiOnce: Object.fromEntries(
        Object.entries(record(raw.aiOnce)).filter(([, v]) => isObject(v) && typeof v.value === 'string')
      ) as PreparedFill['aiOnce'],
      mappedSteps: strings(raw.mappedSteps),
      draftedSteps: strings(raw.draftedSteps),
      asked: strings(raw.asked),
      preparedAt: str(raw.preparedAt) ?? ''
    }
  } catch {
    return null
  }
}

/**
 * What controls spending, out of the workspace (#154 review): the run window switch and today's count, per
 * workspace under `<userData>/automation/<sha256(workspace)>.json`. An agent can write into the workspace, so the
 * workspace's `automation.json` only mirrors these for display; editing or deleting it neither turns the window on
 * nor gives back the day's allowance.
 */
export const trustedFile = (root: string, ws: string): string => join(root, `${createHash('sha256').update(ws).digest('hex')}.json`)

export async function readTrusted(root: string, ws: string): Promise<TrustedUsage | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(trustedFile(root, ws), 'utf8'))
    if (!isObject(raw) || raw.version !== 1) return null
    const day = isObject(raw.day) ? raw.day : {}
    return { enabled: raw.enabled === true, day: { date: str(day.date) ?? '', started: Math.max(0, Math.floor(num(day.started) ?? 0)) } }
  } catch {
    return null
  }
}

const trustedWrites = new Map<string, Promise<unknown>>()

export function writeTrusted(root: string, ws: string, usage: TrustedUsage): Promise<void> {
  const file = trustedFile(root, ws)
  const body = `${JSON.stringify({ version: 1, ...usage }, null, 2)}\n`
  const run = (trustedWrites.get(file) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await mkdir(root, { recursive: true })
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, file)
    })
  trustedWrites.set(file, run)
  const forget = () => {
    if (trustedWrites.get(file) === run) trustedWrites.delete(file)
  }
  run.then(forget, forget)
  return run
}
