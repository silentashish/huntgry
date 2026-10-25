import { appendFile, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_AUTOMATION_STATE, type AutomationLogEntry, type PreparedFill } from '@shared/automation-types'
import { appendLog, flushState, logFile, preparedFile, readLog, readPrepared, readState, readTrusted, stateFile, trustedFile, writePrepared, writeState, writeTrusted } from './store'

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-automation-store-'))
})
afterEach(() => rm(ws, { recursive: true, force: true }))

const entry = (n: number, over: Partial<AutomationLogEntry> = {}): AutomationLogEntry => ({
  at: `2026-10-24T22:0${n}:00.000Z`,
  runId: 'a-1',
  key: `k${n % 2}`,
  step: 'link',
  outcome: 'ok',
  message: `entry ${n}`,
  ...over
})

describe('automation store', () => {
  it('starts empty, and reads back what it wrote', async () => {
    expect(await readState(ws)).toEqual(EMPTY_AUTOMATION_STATE)
    const state = structuredClone(EMPTY_AUTOMATION_STATE)
    state.enabled = true
    state.day = { date: '2026-10-24', started: 3 }
    state.candidates.k = { key: 'k', source: 'jobs', title: 'T', company: 'C', reasons: ['r'], step: 'needs-you', failedStep: 'filling', error: 'Bot check', updatedAt: 'x' }
    await writeState(ws, state)
    await flushState(ws)
    expect(await readState(ws)).toEqual(state)
  })

  it('drops what it cannot read in a hand-edited file', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    await writeFile(stateFile(ws), JSON.stringify({ version: 1, candidates: { a: { key: 'a', step: 'teleported' }, b: { key: 'b', step: 'ready' } }, run: { id: 'r' } }))
    const state = await readState(ws)
    expect(Object.keys(state.candidates)).toEqual(['b'])
    expect(state.run).toBeNull()
    await writeFile(stateFile(ws), '{ not json')
    expect(await readState(ws)).toEqual(EMPTY_AUTOMATION_STATE)
  })

  it('appends the log, reads it newest first, filters by job and limits', async () => {
    for (let i = 1; i <= 5; i++) await appendLog(ws, entry(i))
    expect((await readLog(ws)).map((e) => e.message)).toEqual(['entry 5', 'entry 4', 'entry 3', 'entry 2', 'entry 1'])
    expect((await readLog(ws, { key: 'k0' })).map((e) => e.message)).toEqual(['entry 4', 'entry 2'])
    expect((await readLog(ws, { limit: 2 })).map((e) => e.message)).toEqual(['entry 5', 'entry 4'])
  })

  it('tolerates a torn last line: skipped on read, and the next entry is not glued to it', async () => {
    await appendLog(ws, entry(1))
    await appendFile(logFile(ws), '{"at":"2026-10-24T22:02:00.000Z","runId":"a-1","ke')
    expect((await readLog(ws)).map((e) => e.message)).toEqual(['entry 1'])
    await appendLog(ws, entry(3))
    expect((await readLog(ws)).map((e) => e.message)).toEqual(['entry 3', 'entry 1'])
    const lines = (await readFile(logFile(ws), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('keeps a prepared fill per application, and refuses another application’s file', async () => {
    const fill: PreparedFill = {
      version: 1,
      applicationId: 'embedded-software-engineer/contoso-robotics/e2e0a3',
      url: 'http://127.0.0.1/postings/apply-only',
      report: { ats: 'generic', url: 'http://127.0.0.1/postings/apply-only', fields: [], hasSubmitButton: true },
      drafts: { 'what interests you': 'Fake draft' },
      aiOnce: {},
      mappedSteps: ['u#'],
      draftedSteps: ['u#'],
      asked: ['what interests you'],
      preparedAt: '2026-10-24T22:10:00.000Z'
    }
    await writePrepared(ws, fill)
    expect(preparedFile(ws, fill.applicationId)).toMatch(/embedded-software-engineer_contoso-robotics_e2e0a3\.json$/)
    expect(await readPrepared(ws, fill.applicationId)).toEqual(fill)
    expect(await readPrepared(ws, 'other/app/id')).toBeNull()
  })

  it('a failed write or append rejects to its caller only: no unhandled rejection from the cleanup', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      // `.huntgry` is a file: every write under it fails.
      await writeFile(join(ws, '.huntgry'), 'not a folder')
      await expect(appendLog(ws, entry(1))).rejects.toThrow()
      await expect(writeState(ws, structuredClone(EMPTY_AUTOMATION_STATE))).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps the trusted usage per workspace outside it, and reads nothing for another workspace', async () => {
    const root = join(ws, 'user-data', 'automation')
    expect(await readTrusted(root, '/w1')).toBeNull()
    await writeTrusted(root, '/w1', { enabled: true, day: { date: '2026-10-24', started: 3 } })
    expect(await readTrusted(root, '/w1')).toEqual({ enabled: true, day: { date: '2026-10-24', started: 3 } })
    expect(await readTrusted(root, '/w2')).toBeNull()
    expect(trustedFile(root, '/w1')).not.toContain('w1')
  })
})
