import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunSummary, StartRunParams } from '@shared/runner-types'
import { buildTranscript } from '@shared/transcript'
import { RunManager, type RunContext } from './runner'
import { listRuns, readEvents, readRun, saveRun } from './runs'

const FAKE = join(__dirname, 'fixtures/fake-claude.mjs')
const params: StartRunParams = {
  jobDescription: 'Build APIs at Acme.',
  company: 'Acme',
  role: 'Engineer',
  coverLetter: true,
  dateStyle: 'right'
}

let ws: string
let runs: RunSummary[]
let manager: RunManager
let live: { runId: string; seq: number }[]

function ctx(): RunContext {
  return {
    workspace: ws,
    skillDir: '/skills/resume-tailor',
    sandbox: { workspace: ws, skillDir: '/skills/resume-tailor', venvDir: '/venv', texRoot: null },
    command: process.execPath,
    commandPrefixArgs: [FAKE],
    env: { ...process.env },
    systemPrompt: 'test'
  }
}

/** Waits until the latest broadcast of run `id` satisfies `pred`. */
async function until(id: string, pred: (r: RunSummary) => boolean, ms = 5000): Promise<RunSummary> {
  const start = Date.now()
  for (;;) {
    const last = [...runs].reverse().find((r) => r.id === id)
    if (last && pred(last)) return last
    if (Date.now() - start > ms) throw new Error(`timeout; last status ${last?.status}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-runner-'))
  runs = []
  live = []
  manager = new RunManager({ onEvent: (runId, seq) => live.push({ runId, seq }), onRun: (r) => runs.push(r) })
})

afterEach(async () => {
  manager.stopAll()
  await manager.whenIdle()
  await rm(ws, { recursive: true, force: true })
})

describe('RunManager against a fake claude', () => {
  it('runs a turn, records events and waits for the user', async () => {
    const started = await manager.start(params, ctx())
    expect(started.title).toBe('Engineer · Acme')
    const waiting = await until(started.id, (r) => r.status === 'waiting')
    expect(waiting.sessionId).toBe('sess-fake-1')
    expect(waiting.costUsd).toBeCloseTo(0.01)
    await manager.flush(started.id)

    const events = await readEvents(ws, started.id)
    // Hook events are dropped; the first line is the user's prompt.
    expect(events.some((e) => (e as { subtype?: string }).subtype === 'hook_started')).toBe(false)
    const t = buildTranscript(events)
    expect(t[0]).toMatchObject({ kind: 'user' })
    expect((t[0] as { text: string }).text).toContain('Build APIs at Acme.')
    expect(t.find((i) => i.kind === 'tool')).toMatchObject({ name: 'Read', status: 'ok' })
    expect(t.find((i) => i.kind === 'assistant')).toMatchObject({
      text: expect.stringContaining('echo: Follow the resume-tailor')
    })
    expect(t[t.length - 1]).toMatchObject({ kind: 'result', ok: true })
  })

  it('continues the same process on reply and finds the application folder', async () => {
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    await manager.reply(id, 'Approved. WRITE_OUTPUT', async () => ctx())
    const done = await until(id, (r) => r.status === 'waiting' && r.outputFolder !== null)
    expect(done.outputFolder).toBe(join('software-engineer', 'acme', '42'))
    expect(done.outputFiles).toEqual(['build-report.json', 'resume.pdf'])
    expect((await readRun(ws, id)).outputFolder).toBe(done.outputFolder)
  })

  it('records where the job came from in the application folder', async () => {
    const fromJobs = { ...params, jobUrl: 'https://hiring.cafe/job/abc', source: 'hiring.cafe' as const }
    const { id } = await manager.start(fromJobs, ctx())
    await until(id, (r) => r.status === 'waiting')
    await manager.reply(id, 'Approved. WRITE_OUTPUT', async () => ctx())
    const done = await until(id, (r) => r.status === 'waiting' && r.outputFolder !== null)
    await manager.flush(id)
    const tracking = JSON.parse(await readFile(join(ws, done.outputFolder!, 'huntgry.json'), 'utf8'))
    expect(tracking).toMatchObject({ jobUrl: 'https://hiring.cafe/job/abc', source: 'hiring.cafe' })
  })

  it('writes no tracking file for a run without a posting URL', async () => {
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    await manager.reply(id, 'Approved. WRITE_OUTPUT', async () => ctx())
    const done = await until(id, (r) => r.status === 'waiting' && r.outputFolder !== null)
    await manager.flush(id)
    await expect(readFile(join(ws, done.outputFolder!, 'huntgry.json'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('finishes cleanly when the user ends the run, then resumes the session on a new reply', async () => {
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    manager.finish(id)
    await until(id, (r) => r.status === 'finished' && !r.live)
    expect(manager.isLive(id)).toBe(false)

    await manager.reply(id, 'one more change', async () => ctx())
    const resumed = await until(id, (r) => r.status === 'waiting' && r.live)
    expect(resumed.sessionId).toBe('sess-fake-1')
    await manager.flush(id)
    const events = await readEvents(ws, id)
    const users = buildTranscript(events).filter((i) => i.kind === 'user')
    expect(users).toHaveLength(2)
    // seq keeps counting across the resumed process: every live event's seq is its line in events.jsonl.
    const seqs = live.filter((l) => l.runId === id).map((l) => l.seq)
    expect(seqs).toEqual(events.map((_, i) => i))
  })

  it('marks a resumed run failed when claude cannot be started', async () => {
    // reply() sets the run to "running" before the spawn error arrives, so the close handler fails it.
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    manager.finish(id)
    await until(id, (r) => r.status === 'finished' && !r.live)
    await manager.whenIdle()
    // As after an app restart mid-conversation: waiting for the user, no process.
    await saveRun(ws, { ...(await readRun(ws, id)), status: 'waiting', live: false })

    await manager.reply(id, 'go on', async () => ({ ...ctx(), command: join(ws, 'no-such-claude'), commandPrefixArgs: [] }))
    const failed = await until(id, (r) => r.status === 'failed' && !r.live)
    expect(failed.error).toMatch(/ENOENT/)
    await manager.whenIdle()
    expect((await readRun(ws, id)).status).toBe('failed')
  })

  it('stop kills the process and records it', async () => {
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    manager.stop(id)
    await until(id, (r) => r.status === 'stopped' && !r.live)
    expect(manager.isLive(id)).toBe(false)
  })

  it('reports a crash with the stderr tail', async () => {
    const { id } = await manager.start({ ...params, notes: 'CRASH' }, ctx())
    const failed = await until(id, (r) => r.status === 'failed')
    expect(failed.error).toContain('boom: simulated failure')
    await manager.flush(id)
    const t = buildTranscript(await readEvents(ws, id))
    expect(t[t.length - 1]).toMatchObject({ kind: 'notice', level: 'error' })
  })

  it('lists runs newest first and reads an interrupted run as stopped', async () => {
    const a = await manager.start(params, ctx())
    await until(a.id, (r) => r.status === 'waiting')
    const b = await manager.start({ ...params, company: 'Globex' }, ctx())
    await until(b.id, (r) => r.status === 'waiting')
    await manager.flush(b.id)
    const listed = await listRuns(ws)
    expect(listed.map((r) => r.id)).toEqual([b.id, a.id])
    expect(listed.every((r) => r.live === false)).toBe(true)
    const raw = JSON.parse(await readFile(join(ws, '.huntgry/runs', a.id, 'run.json'), 'utf8'))
    expect(raw.live).toBe(false)
  })
})
