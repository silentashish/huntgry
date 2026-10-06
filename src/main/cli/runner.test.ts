import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    // Under load the first turn's folder scan can run late and see the folder half-written
    // (resume.pdf before build-report.json); wait for the second turn's scan.
    const done = await until(id, (r) => r.status === 'waiting' && r.outputFiles.includes('build-report.json'))
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

  it('two runs building at the same time each record their own application folder', async () => {
    const a = await manager.start(
      { ...params, company: 'Acme', jobId: 'a1', jobUrl: 'https://a.example/1' },
      ctx()
    )
    const b = await manager.start(
      { ...params, company: 'Globex', jobId: 'b2', jobUrl: 'https://b.example/2' },
      ctx()
    )
    await until(a.id, (r) => r.status === 'waiting')
    await until(b.id, (r) => r.status === 'waiting')
    // A writes first but answers last, after B wrote a newer folder.
    await manager.reply(a.id, 'Approved. WRITE_OUTPUT_AT:engineer/acme/a1 SLOW', async () => ctx())
    await new Promise((r) => setTimeout(r, 50))
    await manager.reply(b.id, 'Approved. WRITE_OUTPUT_AT:engineer/globex/b2', async () => ctx())
    const doneB = await until(b.id, (r) => r.status === 'waiting' && r.outputFolder !== null)
    const doneA = await until(a.id, (r) => r.status === 'waiting' && r.outputFolder !== null)
    expect(doneA.outputFolder).toBe(join('engineer', 'acme', 'a1'))
    expect(doneB.outputFolder).toBe(join('engineer', 'globex', 'b2'))
    await manager.flush(a.id)
    await manager.flush(b.id)
    const trackA = JSON.parse(await readFile(join(ws, 'engineer/acme/a1/huntgry.json'), 'utf8'))
    const trackB = JSON.parse(await readFile(join(ws, 'engineer/globex/b2/huntgry.json'), 'utf8'))
    expect(trackA.jobUrl).toBe('https://a.example/1')
    expect(trackB.jobUrl).toBe('https://b.example/2')
  })

  it('does not take the folder of a concurrent run with an overlapping job id before it records it', async () => {
    const a = await manager.start({ ...params, company: 'Acme', jobId: '42', jobUrl: 'https://a.example/42' }, ctx())
    const b = await manager.start({ ...params, company: 'Acme', jobId: '142', jobUrl: 'https://b.example/142' }, ctx())
    await until(a.id, (r) => r.status === 'waiting')
    await until(b.id, (r) => r.status === 'waiting')
    // B writes engineer/acme/142 and answers late; A's turn ends in between with no output of its own.
    await manager.reply(b.id, 'Approved. WRITE_OUTPUT_AT:engineer/acme/142 SLOW', async () => ctx())
    await new Promise((r) => setTimeout(r, 50))
    await manager.reply(a.id, 'one question first', async () => ctx())
    // Each fake turn costs 0.01, so this is A's second turn ending.
    await until(a.id, (r) => r.status === 'waiting' && r.costUsd > 0.015)
    await manager.flush(a.id)
    const doneB = await until(b.id, (r) => r.status === 'waiting' && r.outputFolder !== null)
    expect(doneB.outputFolder).toBe(join('engineer', 'acme', '142'))
    expect(manager.liveRun(a.id)?.outputFolder).toBeNull()
    await manager.flush(b.id)
    const track = JSON.parse(await readFile(join(ws, 'engineer/acme/142/huntgry.json'), 'utf8'))
    expect(track.jobUrl).toBe('https://b.example/142')
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

  it('explains a failure of a Claude Code too old for a flag', async () => {
    const old = { ...ctx(), env: { ...process.env, FAKE_CLAUDE_UNKNOWN: '--permission-prompts' } }
    const r = await manager.start(params, { ...old, claudeVersion: '2.1.231', permissionPrompts: true })
    const failed = await until(r.id, (x) => x.status === 'failed')
    expect(failed.error).toContain('Your Claude Code (2.1.231) does not support --permission-prompts')
    expect(failed.error).toContain("error: unknown option '--permission-prompts'")
  })

  it('keeps the rate-limit event on the run (not in the transcript) and stamps every output line', async () => {
    const { id } = await manager.start({ ...params, notes: 'RATE_WARN' }, ctx())
    const waiting = await until(id, (r) => r.status === 'waiting')
    expect(waiting.rateLimit).toMatchObject({ status: 'allowed_warning', utilization: 0.96, rateLimitType: 'five_hour' })
    expect(typeof waiting.rateLimit?.resetsAt).toBe('number')
    expect(waiting.lastOutputAt).toBeDefined()
    expect(Date.parse(waiting.lastOutputAt!)).toBeGreaterThanOrEqual(Date.parse(waiting.createdAt) - 1000)
    await manager.flush(id)
    const events = await readEvents(ws, id)
    expect(events.some((e) => (e as { type?: string }).type === 'rate_limit_event')).toBe(false)
  })

  it('fails a turn whose result is an error (usage limit), with the reset epoch from the last rate-limit event', async () => {
    const { id } = await manager.start({ ...params, notes: 'USAGE_LIMIT:1790304000' }, ctx())
    const failed = await until(id, (r) => r.status === 'failed')
    expect(failed.error).toContain("You've hit your session limit · resets 3:45pm")
    expect(failed.rateLimit).toMatchObject({ status: 'rejected', resetsAt: 1790304000 })
  })

  it('abort kills the process and fails the run with the given reason, so it can be retried', async () => {
    const { id } = await manager.start({ ...params, notes: 'STALL' }, ctx())
    await until(id, (r) => r.sessionId !== null)
    manager.abort(id, 'No output for 20 minutes.')
    const failed = await until(id, (r) => r.status === 'failed' && !r.live)
    expect(failed.error).toBe('No output for 20 minutes.')
    expect(manager.isLive(id)).toBe(false)
    await manager.flush(id)
    const t = buildTranscript(await readEvents(ws, id))
    expect(t[t.length - 1]).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining('No output for 20 minutes') })
  })

  it('release ends the idle process of a waiting run and keeps it waiting; a reply resumes it', async () => {
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    manager.release(id)
    const released = await until(id, (r) => r.status === 'waiting' && !r.live)
    expect(released.error).toBeUndefined()
    expect(manager.isLive(id)).toBe(false)
    await manager.reply(id, 'go on', async () => ctx())
    expect(manager.isLive(id)).toBe(true)
    await until(id, (r) => r.status === 'waiting' && r.live)
  })

  it('a reply restarts the stall clock (lastOutputAt), even after a long wait', async () => {
    const { id } = await manager.start(params, ctx())
    const waiting = await until(id, (r) => r.status === 'waiting')
    await new Promise((r) => setTimeout(r, 30))
    const before = Date.now()
    const sent = await manager.reply(id, 'next', async () => ctx())
    expect(Date.parse(sent.lastOutputAt!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(sent.lastOutputAt!)).toBeGreaterThan(Date.parse(waiting.lastOutputAt!))
  })

  it('records an unattended run as such, so a resume keeps the variant', async () => {
    const { id, unattended } = await manager.start({ ...params, unattended: true, notes: 'WRITE_NOTES' }, ctx())
    expect(unattended).toBe(true)
    const waiting = await until(id, (r) => r.status === 'waiting')
    expect(waiting.outputFiles).toContain('review-notes.md')
    manager.finish(id)
    await until(id, (r) => r.status === 'finished')
    expect((await readRun(ws, id)).unattended).toBe(true)
  })

  it('does not pass --permission-prompts to an older Claude Code', async () => {
    const old = { ...ctx(), env: { ...process.env, FAKE_CLAUDE_UNKNOWN: '--permission-prompts' } }
    const r = await manager.start(params, { ...old, claudeVersion: '2.1.231', permissionPrompts: false })
    expect((await until(r.id, (x) => x.status !== 'running')).status).toBe('waiting')
  })
})

const FAKE_CODEX = join(__dirname, 'fixtures/fake-codex.mjs')
const FAKE_AGY = join(__dirname, 'fixtures/fake-agy.mjs')
const codexCtx = (): RunContext => ({ ...ctx(), agent: 'codex', commandPrefixArgs: [FAKE_CODEX] })
const agyCtx = (): RunContext => ({ ...ctx(), agent: 'antigravity', commandPrefixArgs: [FAKE_AGY] })

describe('RunManager against a fake codex (one process per turn)', () => {
  it('runs the first turn, then waits with no process left', async () => {
    const started = await manager.start(params, codexCtx())
    expect(started.agent).toBe('codex')
    const waiting = await until(started.id, (r) => r.status === 'waiting' && !r.live)
    expect(waiting.sessionId).toBe('thread-fake-1')
    expect(waiting.usage).toEqual({ inputTokens: 1000, outputTokens: 50 })
    expect(waiting.costUsd).toBe(0)
    expect(manager.isLive(started.id)).toBe(false)
    await manager.whenIdle()
    expect((await readRun(ws, started.id)).agent).toBe('codex')
    const t = buildTranscript(await readEvents(ws, started.id), 'codex')
    expect(t.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant', 'result'])
    expect(t[1]).toMatchObject({ name: 'Bash', status: 'ok', output: 'profile text' })
    // The prompt went in whole on stdin; the process ran in the workspace.
    expect(t[2]).toMatchObject({ text: expect.stringContaining('echo: Follow the resume-tailor skill') })
    expect((t[2] as { text: string }).text).toContain(`cwd=${await realpathOf(ws)}`)
    expect((t[2] as { text: string }).text).toContain('resume=false')
  })

  it('answers a reply with `exec resume <thread>` in the workspace and finds the output', async () => {
    const { id } = await manager.start(params, codexCtx())
    await until(id, (r) => r.status === 'waiting' && !r.live)
    await manager.whenIdle()
    await manager.reply(id, 'Approved. WRITE_OUTPUT', async () => codexCtx())
    const done = await until(id, (r) => r.status === 'waiting' && !r.live && r.outputFolder !== null)
    expect(done.outputFolder).toBe(join('software-engineer', 'acme', '42'))
    expect(done.usage).toEqual({ inputTokens: 2000, outputTokens: 100 })
    await manager.whenIdle()
    const t = buildTranscript(await readEvents(ws, id), 'codex')
    const last = t.filter((i) => i.kind === 'assistant').pop() as { text: string }
    expect(last.text).toContain('resume=true')
    expect(last.text).toContain(`cwd=${await realpathOf(ws)}`)
  })

  it('refuses a second reply while a turn is running', async () => {
    const { id } = await manager.start({ ...params, notes: 'SLOW' }, codexCtx())
    await expect(manager.reply(id, 'again', async () => codexCtx())).rejects.toThrow(/Codex is still working/)
    await until(id, (r) => r.status === 'waiting' && !r.live)
  })

  it('finishes a waiting run that has no process', async () => {
    const { id } = await manager.start(params, codexCtx())
    await until(id, (r) => r.status === 'waiting' && !r.live)
    await manager.whenIdle()
    const done = await manager.endIdle(ws, id, 'finished')
    expect(done?.status).toBe('finished')
    expect(runs[runs.length - 1]).toMatchObject({ id, status: 'finished' })
    expect((await readRun(ws, id)).status).toBe('finished')
    // Nothing to do for a finished run.
    expect(await manager.endIdle(ws, id, 'finished')).toBeNull()
  })

  it('lets only one of two simultaneous replies to an idle run through', async () => {
    const { id } = await manager.start(params, codexCtx())
    await until(id, (r) => r.status === 'waiting' && !r.live)
    await manager.whenIdle()
    const results = await Promise.allSettled([
      manager.reply(id, 'first reply', async () => codexCtx()),
      manager.reply(id, 'second reply', async () => codexCtx())
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/Codex is still working/)
    await until(id, (r) => r.status === 'waiting' && !r.live && (r.usage?.inputTokens ?? 0) === 2000)
    await manager.whenIdle()
    const users = buildTranscript(await readEvents(ws, id), 'codex').filter((i) => i.kind === 'user') as { text: string }[]
    // The refused reply is not recorded as if Codex had received it.
    expect(users.map((u) => u.text).slice(1)).toEqual(['first reply'])
  })

  it('keeps End when it is pressed as soon as the turn is over', async () => {
    for (let i = 0; i < 5; i++) {
      const { id } = await manager.start(params, codexCtx())
      // The first broadcast without a process; the exit's own writes may still be pending.
      await until(id, (r) => r.status === 'waiting' && !r.live)
      expect((await manager.endIdle(ws, id, 'finished'))?.status).toBe('finished')
      await manager.whenIdle()
      expect((await readRun(ws, id)).status).toBe('finished')
    }
  })

  it('stops an idle run (a cancelled queue job) and records it', async () => {
    const { id } = await manager.start(params, codexCtx())
    await until(id, (r) => r.status === 'waiting' && !r.live)
    expect((await manager.endIdle(ws, id, 'stopped'))?.status).toBe('stopped')
    await manager.whenIdle()
    expect((await readRun(ws, id)).status).toBe('stopped')
    const t = buildTranscript(await readEvents(ws, id), 'codex')
    expect(t[t.length - 1]).toMatchObject({ kind: 'notice', text: 'Stopped.' })
  })

  it('fails with the stderr tail when codex crashes', async () => {
    const { id } = await manager.start({ ...params, notes: 'CRASH' }, codexCtx())
    const failed = await until(id, (r) => r.status === 'failed')
    expect(failed.error).toContain('boom: simulated codex failure')
    await manager.whenIdle()
    const t = buildTranscript(await readEvents(ws, id), 'codex')
    expect(t[t.length - 1]).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringMatching(/^Codex stopped:/) })
  })

  it('fails a turn codex reports as failed, and one that exits without ending the turn', async () => {
    const a = await manager.start({ ...params, notes: 'FAIL_TURN' }, codexCtx())
    expect((await until(a.id, (r) => r.status === 'failed')).error).toContain('stream disconnected')
    const b = await manager.start({ ...params, notes: 'SILENT' }, codexCtx())
    expect((await until(b.id, (r) => r.status === 'failed')).error).toContain('exited before the turn ended')
  })

  it('fails a turn that ends with no output and nothing done, instead of waiting for a reply to nothing', async () => {
    const { id } = await manager.start({ ...params, notes: 'EMPTY' }, codexCtx())
    const failed = await until(id, (r) => r.status === 'failed' && !r.live)
    expect(failed.error).toContain('Codex ended the turn without any answer or action.')
    // The session is known, so the user can retry with a reply.
    expect(failed.sessionId).toBe('thread-fake-1')
    await manager.whenIdle()
    const t = buildTranscript(await readEvents(ws, id), 'codex')
    expect(t[t.length - 1]).toMatchObject({ kind: 'notice', level: 'error' })
    // Something the agent did (here only reasoning, also reported as 0 output tokens) is not an empty turn.
    const other = await manager.start({ ...params, notes: 'REASONING_ONLY' }, codexCtx())
    expect((await until(other.id, (r) => r.status !== 'running' && !r.live)).status).toBe('waiting')
  })

  it('continues a run only with its own agent', async () => {
    const { id } = await manager.start(params, codexCtx())
    await until(id, (r) => r.status === 'waiting' && !r.live)
    await manager.whenIdle()
    await expect(manager.reply(id, 'hi', async () => ctx())).rejects.toThrow(/uses Codex/)
  })
})

describe('RunManager against a fake agy (stream-json in and out)', () => {
  it('prefixes the Huntgry context to the first message and keeps the process between turns', async () => {
    const { id } = await manager.start(params, agyCtx())
    const waiting = await until(id, (r) => r.status === 'waiting')
    expect(waiting).toMatchObject({ agent: 'antigravity', sessionId: 'conv-fake-1', live: true })
    expect(waiting.usage).toEqual({ inputTokens: 2000, outputTokens: 70 })
    await manager.reply(id, 'Approved. WRITE_OUTPUT', async () => agyCtx())
    const done = await until(id, (r) => r.status === 'waiting' && r.outputFolder !== null)
    expect(done.live).toBe(true)
    await manager.flush(id)
    const t = buildTranscript(await readEvents(ws, id), 'antigravity')
    // The transcript shows what the user sent, not the context.
    const users = t.filter((i) => i.kind === 'user') as { text: string }[]
    expect(users[0].text).not.toContain('huntgry_instructions')
    const replies = t.filter((i) => i.kind === 'assistant') as { text: string }[]
    expect(replies[0].text).toBe('echo: <huntgry_instructions>\ntest\n</huntgry_in')
    expect(replies[1].text).toBe('echo: Approved. WRITE_OUTPUT')
    expect(t.find((i) => i.kind === 'tool')).toMatchObject({ name: 'view_file', status: 'ok' })
  })

  it('resumes the conversation after the run was finished', async () => {
    const { id } = await manager.start(params, agyCtx())
    await until(id, (r) => r.status === 'waiting')
    manager.finish(id)
    await until(id, (r) => r.status === 'finished' && !r.live)
    await manager.reply(id, 'one more change', async () => agyCtx())
    const resumed = await until(id, (r) => r.status === 'waiting' && r.live)
    expect(resumed.sessionId).toBe('conv-fake-1')
  })

  it('fails with a readable reason when the quota is used up', async () => {
    const { id } = await manager.start({ ...params, notes: 'QUOTA' }, agyCtx())
    const failed = await until(id, (r) => r.status === 'failed')
    expect(failed.error).toMatch(/^Antigravity's quota is used up: RESOURCE_EXHAUSTED \(code 429\)/)
    await manager.whenIdle()
    const t = buildTranscript(await readEvents(ws, id), 'antigravity')
    expect(t.map((i) => i.kind)).toEqual(['user', 'result', 'notice'])
    expect(t[2]).toMatchObject({ level: 'error', text: expect.stringMatching(/^Antigravity stopped: .*quota/) })
  })

  it('reports a crash with the stderr tail', async () => {
    const { id } = await manager.start({ ...params, notes: 'CRASH' }, agyCtx())
    expect((await until(id, (r) => r.status === 'failed')).error).toContain('panic: simulated agy failure')
  })
})

describe('runs recorded before agents', () => {
  it('read as Claude runs', async () => {
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    expect(runs[runs.length - 1].agent).toBe('claude')
    await manager.flush(id)
    const file = join(ws, '.huntgry/runs', id, 'run.json')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    delete raw.agent
    await writeFile(file, JSON.stringify(raw))
    expect((await readRun(ws, id)).agent).toBe('claude')
  })
})

async function realpathOf(p: string): Promise<string> {
  return (await import('node:fs/promises')).realpath(p)
}

describe('RunManager metrics (#44)', () => {
  it('records each turn: active time from send to turn end, never the wait for the reply', async () => {
    const { id } = await manager.start(params, ctx())
    const first = await until(id, (r) => r.status === 'waiting' && (r.metrics?.length ?? 0) === 1)
    expect(first.model).toBe('claude-haiku-4-5-20251001')
    expect(first.metrics![0]).toMatchObject({
      turn: 1,
      ok: true,
      model: 'claude-haiku-4-5-20251001',
      reportedCostUsd: 0.01,
      usage: { inputTokens: 1000, outputTokens: 1800 }
    })
    // The table's price of the fake's tokens is the CLI's own figure.
    expect(first.metrics![0].estimatedCostUsd).toBeCloseTo(0.01, 9)
    // The user takes a while to answer: none of it is active time.
    await new Promise((r) => setTimeout(r, 400))
    const sent = Date.now()
    await manager.reply(id, 'SLOW go on', async () => ctx())
    const second = await until(id, (r) => r.status === 'waiting' && (r.metrics?.length ?? 0) === 2)
    const took = Date.now() - sent
    const [a, b] = second.metrics!
    expect(b.turn).toBe(2)
    expect(b.activeMs).toBeGreaterThanOrEqual(300)
    expect(b.activeMs).toBeLessThanOrEqual(took + 50)
    expect(Date.parse(b.startedAt)).toBeGreaterThanOrEqual(Date.parse(a.endedAt) + 300)
    // The session's running cost (0.02) is split per turn, not added up again.
    expect(b.reportedCostUsd).toBeCloseTo(0.01, 9)
    expect(second.costUsd).toBeCloseTo(0.02, 9)
    expect(second.totals).toMatchObject({ turns: 2, activeMs: a.activeMs + b.activeMs, pricedTurns: 2, unpricedTurns: 0 })
    expect(second.totals!.estimatedCostUsd).toBeCloseTo(0.02, 9)
    expect(second.usage).toBeUndefined()
    const t = buildTranscript(await readEvents(ws, id))
    expect(t.filter((i) => i.kind === 'result').map((i) => (i as { turn?: number }).turn)).toEqual([1, 2])
  })

  it('a stopped turn still records its time, with no tokens', async () => {
    const { id } = await manager.start({ ...params, notes: 'STALL' }, ctx())
    await new Promise((r) => setTimeout(r, 200))
    manager.stop(id)
    const stopped = await until(id, (r) => r.status === 'stopped' && !r.live)
    expect(stopped.metrics).toHaveLength(1)
    expect(stopped.metrics![0]).toMatchObject({ turn: 1, ok: false, usageIncomplete: true, usage: { inputTokens: 0, outputTokens: 0 } })
    expect(stopped.totals).toMatchObject({ incompleteTurns: 1 })
    expect(stopped.metrics![0].activeMs).toBeGreaterThanOrEqual(150)
    expect((await readRun(ws, id)).metrics).toHaveLength(1)
  })

  it('a turn stopped mid-way keeps the usage Claude reported per request, once per request', async () => {
    const { id } = await manager.start({ ...params, notes: 'PARTIAL_STALL' }, ctx())
    await new Promise((r) => setTimeout(r, 300))
    manager.stop(id)
    const stopped = await until(id, (r) => r.status === 'stopped' && !r.live)
    const [t] = stopped.metrics!
    expect(t).toMatchObject({
      ok: false,
      usageIncomplete: true,
      model: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 10, cacheReadTokens: 1200, cacheWriteTokens: 800, cacheWrite1hTokens: 800, outputTokens: 3 }
    })
    expect(t.estimatedCostUsd).toBeCloseTo((10 * 1 + 1200 * 0.1 + 800 * 2 + 3 * 5) / 1e6, 12)
    // The CLI's running totals may report these again at the next turn: remembered, to subtract.
    expect(stopped.cliCounters?.interrupted).toEqual({ 'claude-haiku-4-5-20251001': t.usage })
  })

  it('a resumed turn is priced with the model of its own process (Codex -m changed between turns)', async () => {
    const { id } = await manager.start(params, { ...codexCtx(), model: 'gpt-6.1-sol' })
    await until(id, (r) => r.status === 'waiting' && !r.live)
    await manager.whenIdle()
    await manager.reply(id, 'again', async () => ({ ...codexCtx(), model: 'gpt-6-astra' }))
    const done = await until(id, (r) => r.status === 'waiting' && !r.live && (r.metrics?.length ?? 0) === 2)
    expect(done.metrics!.map((m) => m.model)).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])
    expect(done.metrics![0].estimatedCostUsd).toBeCloseTo((1000 * 2 + 50 * 10) / 1e6, 12)
    expect(done.metrics![1].estimatedCostUsd).toBeCloseTo((1000 * 10 + 50 * 50) / 1e6, 12)
    expect(done.model).toBe('gpt-6-astra')
    // Codex with no model passed: unknown, not the last turn's.
    await manager.whenIdle()
    await manager.reply(id, 'third', async () => codexCtx())
    const third = await until(id, (r) => r.status === 'waiting' && !r.live && (r.metrics?.length ?? 0) === 3)
    expect(third.metrics![2].model).toBeNull()
  })

  it('records the turn start while it runs, so the waiting time freezes', async () => {
    const { id } = await manager.start({ ...params, notes: 'SLOW' }, ctx())
    const running = await until(id, (r) => r.status === 'running' && !!r.turnStartedAt)
    expect(Date.parse(running.turnStartedAt!)).toBeGreaterThan(0)
    const waiting = await until(id, (r) => r.status === 'waiting' && (r.metrics?.length ?? 0) === 1)
    expect(waiting.turnStartedAt).toBeUndefined()
  })

  it('a failed Codex turn that reports no usage is "usage unknown", not a free turn', async () => {
    const { id } = await manager.start({ ...params, notes: 'FAIL_TURN' }, { ...codexCtx(), model: 'gpt-6.1-sol' })
    const failed = await until(id, (r) => r.status === 'failed' && !r.live && (r.metrics?.length ?? 0) === 1)
    expect(failed.metrics![0]).toMatchObject({ ok: false, usageIncomplete: true, model: 'gpt-6.1-sol', usage: { inputTokens: 0, outputTokens: 0 } })
    expect(failed.totals).toMatchObject({ incompleteTurns: 1 })
  })

  it('a failed turn records its tokens and time (Claude error result)', async () => {
    const { id } = await manager.start({ ...params, notes: 'BUILT_THEN_ERROR' }, ctx())
    const failed = await until(id, (r) => r.status === 'failed' && !r.live)
    expect(failed.metrics).toHaveLength(1)
    expect(failed.metrics![0]).toMatchObject({ ok: false, reportedCostUsd: 0.01, usage: { inputTokens: 1000, outputTokens: 100 } })
  })

  it('Codex: the thread running totals become per-turn tokens; the model is the one passed with -m', async () => {
    const { id } = await manager.start(params, { ...codexCtx(), model: 'gpt-6.1-sol' })
    await until(id, (r) => r.status === 'waiting' && !r.live)
    await manager.whenIdle()
    await manager.reply(id, 'again', async () => ({ ...codexCtx(), model: 'gpt-6.1-sol' }))
    const done = await until(id, (r) => r.status === 'waiting' && !r.live && (r.metrics?.length ?? 0) === 2)
    expect(done.metrics!.map((m) => [m.model, m.usage.inputTokens, m.usage.outputTokens])).toEqual([
      ['gpt-6.1-sol', 1000, 50],
      ['gpt-6.1-sol', 1000, 50]
    ])
    expect(done.totals!.estimatedCostUsd).toBeCloseTo(2 * (1000 * 2 + 50 * 10) / 1e6, 12)
  })

  it('Antigravity: the model of its own settings prices the run', async () => {
    const { id } = await manager.start(params, { ...agyCtx(), expectedModel: 'Claude Opus 4.6 (Thinking)' })
    const w = await until(id, (r) => r.status === 'waiting' && (r.metrics?.length ?? 0) === 1)
    expect(w.metrics![0]).toMatchObject({ model: 'Claude Opus 4.6 (Thinking)', usage: { inputTokens: 2000, outputTokens: 70 } })
    expect(w.metrics![0].estimatedCostUsd).toBeCloseTo((2000 * 5 + 70 * 25) / 1e6, 12)
  })

  it('an unknown model is "not priced" (null), never $0', async () => {
    const { id } = await manager.start(params, codexCtx())
    const w = await until(id, (r) => r.status === 'waiting' && !r.live && (r.metrics?.length ?? 0) === 1)
    expect(w.model).toBeNull()
    expect(w.metrics![0].estimatedCostUsd).toBeNull()
    expect(w.totals).toMatchObject({ estimatedCostUsd: 0, unpricedTurns: 1 })
  })

  it('a resumed run recorded before metrics is backfilled first, so the resumed turn is not overcounted', async () => {
    const { id } = await manager.start(params, ctx())
    await until(id, (r) => r.status === 'waiting')
    manager.finish(id)
    await until(id, (r) => r.status === 'finished' && !r.live)
    await manager.whenIdle()
    // Make it look like a run from before #44.
    const old = await readRun(ws, id)
    delete old.metrics
    delete old.totals
    delete old.cliCounters
    old.costUsd = 0.01
    await saveRun(ws, old)
    await manager.reply(id, 'more', async () => ctx())
    const done = await until(id, (r) => r.status === 'waiting' && (r.metrics?.length ?? 0) === 2)
    expect(done.backfilled).toBe(true)
    expect(done.metrics!.map((m) => m.reportedCostUsd)).toEqual([0.01, expect.closeTo(0.01, 9)])
    expect(done.costUsd).toBeCloseTo(0.02, 9)
  })

  it('records the batch id of a bulk request on the run', async () => {
    const { id } = await manager.start({ ...params, batchId: 'b-20261006-120000-abcdef' }, ctx())
    expect((await readRun(ws, id)).params.batchId).toBe('b-20261006-120000-abcdef')
  })
})
