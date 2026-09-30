import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adapterFor, type AgentSignal } from '../../../src/main/cli/agents'
import { buildTranscript, LineBuffer, parseEventLine } from '../../../src/shared/transcript'
import { parseAuthStatus } from '../../../src/main/cli/install-claude'
import { CLAUDE_VERSION_RECOMMENDED, parseClaudeVersion, versionAtLeast } from '../../../src/main/cli/version'
import { parsePreflight } from '../../../src/main/cli/env'

/**
 * The scripted agent CLIs (`agent.mjs`) checked against the code that parses
 * them: each adapter's `signal()` must see the init, the content and the turn
 * end the runner relies on, and `buildTranscript` must fold the events into
 * the user-visible items. The runner itself is not involved here (its own
 * tests use src/main/cli/fixtures); the e2e specs drive it through the app.
 */

const SHIM = join(__dirname, 'agent.mjs')
const FIRST = [
  'Follow the resume-tailor skill (SKILL.md) to tailor my resume and cover letter for this job.',
  '',
  'Company: Acme Corp',
  'Role: Staff Engineer',
  'Job id: A-42',
  'Cover letter: no, resume only',
  '',
  'Job description (save it verbatim as job-description.md):',
  '',
  '<job_description>',
  'Build the platform.',
  '</job_description>'
].join('\n')

let home: string
let cwd: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fake-agent-home-'))
  cwd = await mkdtemp(join(tmpdir(), 'fake-agent-ws-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

interface Outcome {
  code: number | null
  events: Record<string, unknown>[]
  stdout: string
  stderr: string
}

/** Runs the shim as the app would: stdin lines in, JSON lines out, in `cwd`. */
function run(agent: string, args: string[], stdin: string[], env: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, agent, ...args], {
      cwd,
      env: { ...process.env, FAKE_AGENT_HOME: home, ...env }
    })
    const lines = new LineBuffer()
    const events: Record<string, unknown>[] = []
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      for (const line of lines.push(chunk)) {
        const e = parseEventLine(line)
        if (e) events.push(e)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('close', (code) => {
      for (const line of lines.flush()) {
        const e = parseEventLine(line)
        if (e) events.push(e)
      }
      resolve({ code, events, stdout, stderr })
    })
    for (const line of stdin) child.stdin.write(line)
    child.stdin.end()
  })
}

const signals = (agent: 'claude' | 'codex' | 'antigravity', events: Record<string, unknown>[]): AgentSignal[] =>
  events.map((e) => adapterFor(agent).signal(e))

const claudeLine = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
const agyLine = (text: string) => `${JSON.stringify({ event: 'user', message: { content: text } })}\n`

async function builtFiles(): Promise<string[]> {
  return (await readdir(join(cwd, 'staff-engineer/acme-corp/a-42'))).sort()
}

describe('fake claude', () => {
  it('speaks stream-json: init with a session, content, one result per turn, files on approval', async () => {
    const out = await run('claude', ['-p', '--input-format', 'stream-json'], [claudeLine(FIRST), claudeLine('Approved, go ahead.')])
    expect(out.code).toBe(0)
    const sig = signals('claude', out.events)
    // The runner learns the session from `system/init`; hook chatter is dropped.
    expect(sig[0]).toEqual({ type: 'drop' })
    expect(sig[1]).toMatchObject({ type: 'init', sessionId: expect.stringMatching(/^claude-session-/) })
    const ends = sig.filter((s) => s.type === 'turn-end')
    expect(ends).toHaveLength(2)
    expect(ends[0]).toMatchObject({ type: 'turn-end', costUsd: 0.0123 })
    expect(sig.every((s) => s.type !== 'turn-end' || !s.error)).toBe(true)

    const t = buildTranscript(out.events, 'claude')
    expect(t.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant', 'result', 'assistant', 'tool', 'assistant', 'result'])
    expect(t[1]).toMatchObject({ name: 'Read', status: 'ok', output: 'profile text' })
    expect(t[2]).toMatchObject({ text: expect.stringMatching(/Do you approve/) })
    expect(t[3]).toMatchObject({ kind: 'result', ok: true })
    expect(t[5]).toMatchObject({ name: 'Bash', status: 'ok' })
    expect(t[6]).toMatchObject({ text: expect.stringContaining(join(cwd, 'staff-engineer/acme-corp/a-42')) })
    expect(await builtFiles()).toEqual(['build-report.json', 'job-description.md', 'resume.pdf', 'resume_data.json'])
    expect(await readFile(join(cwd, 'staff-engineer/acme-corp/a-42/resume.pdf'), 'utf8')).toMatch(/^%PDF-1\.4/)
    expect(JSON.parse(await readFile(join(cwd, 'staff-engineer/acme-corp/a-42/build-report.json'), 'utf8'))).toMatchObject({ ok: true })
    expect(await readFile(join(cwd, 'staff-engineer/acme-corp/a-42/job-description.md'), 'utf8')).toContain('Build the platform.')
  })

  it('reuses the session id it is resumed with and writes the job it remembered', async () => {
    const first = await run('claude', [], [claudeLine(FIRST)])
    const init = signals('claude', first.events).find((s) => s.type === 'init') as { sessionId: string }
    const second = await run('claude', ['--resume', init.sessionId], [claudeLine('approve')])
    const again = signals('claude', second.events).find((s) => s.type === 'init') as { sessionId: string }
    expect(again.sessionId).toBe(init.sessionId)
    expect(await builtFiles()).toContain('resume.pdf')
    const marks = (await readFile(join(home, 'invocations.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(marks.filter((m) => m.mode === 'run').map((m) => m.resume)).toEqual([null, init.sessionId])
  })

  it('answers --version with an accepted version and auth status as signed in', async () => {
    const v = await run('claude', ['--version'], [])
    expect(parseClaudeVersion(v.stdout)).toBe('9.9.9')
    expect(versionAtLeast(parseClaudeVersion(v.stdout), CLAUDE_VERSION_RECOMMENDED)).toBe(true)
    const a = await run('claude', ['auth', 'status'], [])
    expect(parseAuthStatus(a.code ?? 1, a.stdout)).toMatchObject({ loggedIn: true, email: 'fake@example.com' })
  })

  it('fails mid-turn with FAKE_AGENT_SCRIPT=fail and exits after init with exit-early', async () => {
    const fail = await run('claude', [], [claudeLine(FIRST)], { FAKE_AGENT_SCRIPT: 'fail' })
    expect(fail.code).toBe(3)
    expect(fail.stderr).toContain('boom: simulated agent failure')
    expect(signals('claude', fail.events).some((s) => s.type === 'turn-end')).toBe(false)
    const early = await run('claude', [], [claudeLine(FIRST)], { FAKE_AGENT_SCRIPT: 'exit-early' })
    expect(early.code).toBe(0)
    expect(signals('claude', early.events).map((s) => s.type)).toEqual(['drop', 'init'])
  })

  it('pauses between events with FAKE_AGENT_SCRIPT=slow', async () => {
    const started = Date.now()
    const out = await run('claude', [], [claudeLine(FIRST)], { FAKE_AGENT_SCRIPT: 'slow', FAKE_AGENT_SLOW_MS: '120' })
    // Three pauses in the first turn.
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 120)
    expect(signals('claude', out.events).filter((s) => s.type === 'turn-end')).toHaveLength(1)
  })
})

describe('fake codex', () => {
  it('runs one turn per process and resumes the thread in the next one', async () => {
    const first = await run('codex', ['exec', '--json', '-C', cwd, '-'], [FIRST])
    expect(first.code).toBe(0)
    const sig = signals('codex', first.events)
    expect(sig[0]).toMatchObject({ type: 'init', sessionId: expect.stringMatching(/^codex-session-/) })
    expect(sig[sig.length - 1]).toEqual({ type: 'turn-end', usage: { inputTokens: 1200, outputTokens: 80 } })
    expect(sig.filter((s) => s.type === 'keep' && s.content)).toHaveLength(4)
    const t = buildTranscript(first.events, 'codex')
    expect(t.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant', 'result'])
    expect(t[1]).toMatchObject({ name: 'Bash', status: 'ok', output: 'profile text' })

    const thread = (sig[0] as { sessionId: string }).sessionId
    const second = await run('codex', ['exec', 'resume', thread, '--json', '-'], ['Approved'])
    expect(signals('codex', second.events)[0]).toEqual({ type: 'init', sessionId: thread })
    expect(await builtFiles()).toContain('resume.pdf')
  })

  it('reports a failed turn the way the adapter expects', async () => {
    const out = await run('codex', ['exec', '--json', '-'], [FIRST], { FAKE_AGENT_SCRIPT: 'fail' })
    expect(out.code).toBe(3)
    const end = signals('codex', out.events).find((s) => s.type === 'turn-end')
    expect(end).toMatchObject({ type: 'turn-end', error: 'boom: simulated agent failure' })
  })
})

describe('fake agy', () => {
  it('needs --print=, announces the conversation, streams text deltas and ends with a SUCCESS result', async () => {
    const noPrint = await run('agy', ['--input-format', 'stream-json'], [agyLine(FIRST)])
    expect(noPrint.code).toBe(2)
    const out = await run(
      'agy',
      ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print='],
      [agyLine(`<huntgry_instructions>\ncontext\n</huntgry_instructions>\n\n${FIRST}`), agyLine('I approve.')]
    )
    expect(out.code).toBe(0)
    const sig = signals('antigravity', out.events)
    expect(sig[0]).toMatchObject({ type: 'init', sessionId: expect.stringMatching(/^agy-session-/) })
    const ends = sig.filter((s) => s.type === 'turn-end')
    expect(ends).toHaveLength(2)
    expect(ends[0]).toMatchObject({ usage: { inputTokens: 1500, outputTokens: 90 }, error: undefined })
    const t = buildTranscript(out.events, 'antigravity')
    expect(t.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant', 'result', 'assistant', 'tool', 'assistant', 'result'])
    expect(t[0]).toMatchObject({ text: 'Gap analysis for staff-engineer at acme-corp (job a-42): reading the master profile first.' })
    expect(t[1]).toMatchObject({ name: 'view_file', status: 'ok' })
    expect(await builtFiles()).toContain('resume_data.json')
  })

  it('resumes with --conversation and fails with an AGY_ERROR the adapter can explain', async () => {
    const first = await run('agy', ['--print='], [agyLine(FIRST)])
    const conv = (signals('antigravity', first.events)[0] as { sessionId: string }).sessionId
    const second = await run('agy', ['--conversation', conv, '--print='], [agyLine('one more change')], { FAKE_AGENT_SCRIPT: 'fail' })
    expect(signals('antigravity', second.events)[0]).toEqual({ type: 'init', sessionId: conv })
    expect(signals('antigravity', second.events).find((s) => s.type === 'turn-end')).toMatchObject({ error: 'boom: simulated agent failure' })
    expect(adapterFor('antigravity').explainFailure(second.stderr, null)).toBe('boom: simulated agent failure')
  })
})

describe('fixture skill', () => {
  it('has a preflight that reports everything present, in the format the app parses', async () => {
    const out = await new Promise<string>((resolve) => {
      const child = spawn('python3', [join(__dirname, 'skill/scripts/preflight.py')], { cwd: join(__dirname, 'skill') })
      let text = ''
      child.stdout.on('data', (d: Buffer) => (text += d.toString()))
      child.on('close', () => resolve(text))
    })
    const items = parsePreflight(out)
    expect(items.length).toBeGreaterThan(3)
    expect(items.filter((i) => i.status === 'missing')).toEqual([])
    expect(items.map((i) => i.name)).toContain('pdflatex')
  })
})
