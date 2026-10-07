import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_IDS } from '@shared/runner-types'
import { buildTranscript, formatUsage } from '@shared/transcript'
import { buildClaudeArgs, requireStartParams, type SandboxPaths } from '../command'
import { describeAgent } from '../environment'
import { AGENTS, adapterFor, agentOr } from '.'
import { buildAntigravityArgs, explainAgyError } from './antigravity'
import { buildCodexArgs, codexModel } from './codex'
import { installAgentSkill, skillStatus } from './skills'
import type { AgentInvocation } from './types'

const FIXTURES = join(__dirname, '../fixtures')
const sandbox: SandboxPaths = {
  workspace: '/ws',
  skillDir: '/home/u/.agents/skills/resume-tailor',
  venvDir: '/venv',
  texRoot: '/home/u/Library/TinyTeX',
  extraRead: ['/ws', '/home/u/.agents/skills/resume-tailor', '/real/skills/resume-tailor', '/venv']
}
const inv: AgentInvocation = { skillDir: sandbox.skillDir, systemPrompt: 'Huntgry "context"\nline 2', sandbox }

async function jsonl(name: string): Promise<unknown[]> {
  return (await readFile(join(FIXTURES, name), 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

describe('agent registry', () => {
  it('has one adapter per agent id', () => {
    expect(Object.keys(AGENTS).sort()).toEqual([...AGENT_IDS].sort())
    for (const id of AGENT_IDS) expect(adapterFor(id).id).toBe(id)
  })

  it('reads unknown stored agents as the default', () => {
    expect(agentOr('codex')).toBe('codex')
    expect(agentOr('gpt')).toBe('claude')
    expect(agentOr(undefined, 'antigravity')).toBe('antigravity')
  })

  it('validates the agent of a start request', () => {
    const base = { jobDescription: 'x', coverLetter: true, dateStyle: 'right' }
    expect(requireStartParams({ ...base, agent: 'codex' }).agent).toBe('codex')
    expect(requireStartParams(base).agent).toBeUndefined()
    expect(() => requireStartParams({ ...base, agent: 'gpt' })).toThrow(/Unknown agent/)
    expect(() => requireStartParams({ ...base, agent: '../bin/sh' })).toThrow(/Unknown agent/)
  })
})

describe('Claude adapter', () => {
  it('keeps the Claude command line as it was', () => {
    expect(AGENTS.claude.args({ ...inv, model: 'opus', resumeSessionId: 's1', permissionPrompts: true })).toEqual(
      buildClaudeArgs({ ...inv, model: 'opus', resumeSessionId: 's1', permissionPrompts: true })
    )
    expect(AGENTS.claude.firstMessage('hi', 'ctx')).toBe('hi')
  })

  it('drops hook chatter and reads the session and cost', () => {
    const s = AGENTS.claude.signal
    expect(s({ type: 'system', subtype: 'hook_started' })).toEqual({ type: 'drop' })
    expect(s({ type: 'rate_limit_event' })).toEqual({ type: 'drop' })
    expect(s({ type: 'system', subtype: 'init', session_id: 'a' })).toEqual({ type: 'init', sessionId: 'a' })
    expect(s({ type: 'result', total_cost_usd: 0.5, session_id: 'a' })).toEqual({
      type: 'turn-end',
      sessionId: 'a',
      costUsd: 0.5
    })
  })
})

describe('Codex adapter', () => {
  it('runs exec with JSON output, the workspace sandbox and no network, prompt on stdin', () => {
    const args = buildCodexArgs({ ...inv, model: 'gpt-6-sol' })
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toEqual(expect.arrayContaining(['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']))
    expect(args.join(' ')).toContain('-C /ws -s workspace-write')
    expect(args).toContain('approval_policy="never"')
    expect(args).toContain('sandbox_workspace_write.network_access=false')
    expect(args).toContain('web_search="disabled"')
    expect(args).toContain(`developer_instructions=${JSON.stringify(inv.systemPrompt)}`)
    expect(args.join(' ')).toContain('-m gpt-6-sol')
    expect(args[args.length - 1]).toBe('-')
    for (const bad of ['--ephemeral', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '-a'])
      expect(args).not.toContain(bad)
  })

  it('resumes the thread in a new process without -C', () => {
    const args = buildCodexArgs({ ...inv, resumeSessionId: 'thread-1' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1'])
    expect(args).toContain('sandbox_mode="workspace-write"')
    expect(args).toContain('sandbox_workspace_write.network_access=false')
    expect(args).not.toContain('-C')
    expect(args).not.toContain('-s')
    expect(args[args.length - 1]).toBe('-')
  })

  it('sends the prompt as plain text and reads thread ids, usage and failures', () => {
    const c = AGENTS.codex
    expect(c.turnMode).toBe('exec')
    expect(c.userMessage('hello')).toBe('hello')
    expect(c.signal({ type: 'thread.started', thread_id: 't1' })).toEqual({ type: 'init', sessionId: 't1' })
    expect(c.signal({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })).toEqual({
      type: 'turn-end',
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 },
      usageScope: 'session'
    })
    expect(c.signal({ type: 'turn.failed', error: { message: 'nope' } })).toEqual({ type: 'turn-end', error: 'nope' })
    expect(c.signal({ type: 'item.completed', item: {} })).toEqual({ type: 'keep' })
    expect(c.signal({ type: 'item.started', item: { type: 'command_execution' } })).toEqual({ type: 'keep', content: true })
    expect(c.signal({ type: 'turn.started' })).toEqual({ type: 'keep' })
    expect(c.explainFailure('Error: not logged in', null)).toMatch(/codex login/)
    expect(c.explainFailure('boom', null)).toBeNull()
  })

  it("reads the model from Codex's config.toml, top level only", async () => {
    const home = await mkdtemp(join(tmpdir(), 'huntgry-codex-'))
    try {
      expect(await codexModel(home)).toBeUndefined()
      await mkdir(join(home, '.codex'))
      await writeFile(join(home, '.codex/config.toml'), 'model = "gpt-6-sol" # mine\n[profiles.x]\nmodel = "other"\n')
      expect(await codexModel(home)).toBe('gpt-6-sol')
      await writeFile(join(home, '.codex/config.toml'), '[profiles.x]\nmodel = "other"\n')
      expect(await codexModel(home)).toBeUndefined()
      await writeFile(join(home, '.codex/config.toml'), 'model = "$(rm -rf ~)"\n')
      expect(await codexModel(home)).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('Antigravity adapter', () => {
  it('streams turns over stdin in a sandbox with the skill, venv and TeX mounted', () => {
    const args = buildAntigravityArgs(inv)
    expect(args.join(' ')).toContain('--input-format stream-json --output-format stream-json --mode accept-edits --sandbox')
    expect(args.join(' ')).toContain('--print-timeout 0')
    expect(args).toContain('--disable-slash-commands')
    const dirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []))
    expect(dirs).toEqual(
      expect.arrayContaining([sandbox.skillDir, '/real/skills/resume-tailor', '/venv', '/home/u/Library/TinyTeX'])
    )
    expect(dirs).not.toContain('/ws')
    // `-p` takes a value: an empty one, last, so it cannot swallow a flag.
    expect(args[args.length - 1]).toBe('--print=')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--conversation')
    expect(buildAntigravityArgs({ ...inv, resumeSessionId: 'c1' }).join(' ')).toContain('--conversation c1 --print=')
  })

  it('puts the Huntgry context into the first message and encodes turns as agy expects', () => {
    const a = AGENTS.antigravity
    expect(a.firstMessage('Tailor this.', 'CTX')).toBe('<huntgry_instructions>\nCTX\n</huntgry_instructions>\n\nTailor this.')
    expect(JSON.parse(a.userMessage('hi "there"'))).toEqual({ event: 'user', message: { content: 'hi "there"' } })
    expect(a.userMessage('x').endsWith('\n')).toBe(true)
  })

  it('reads the conversation id and turn results', async () => {
    const a = AGENTS.antigravity
    const [init, , , result] = (await jsonl('agy-quota.jsonl')) as Record<string, unknown>[]
    expect(a.signal(init)).toEqual({ type: 'init', sessionId: '3e8616e9-f0db-485b-be28-5409fcfda723' })
    expect(a.signal(result)).toMatchObject({ type: 'turn-end', error: expect.stringContaining('Individual quota reached') })
    expect(
      a.signal({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'c', usage: { input_tokens: 5, output_tokens: 1 } } })
    ).toEqual({
      type: 'turn-end',
      sessionId: 'c',
      usage: { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 },
      usageScope: 'turn',
      error: undefined
    })
  })

  it('explains AGY_ERROR lines, including a used-up quota', async () => {
    const stderr = await readFile(join(FIXTURES, 'agy-quota.stderr'), 'utf8')
    expect(explainAgyError(`error: Individual quota reached.\n${stderr}`)).toMatch(
      /^Antigravity's quota is used up: RESOURCE_EXHAUSTED \(code 429\).*pick another agent\.$/
    )
    expect(explainAgyError('AGY_ERROR: {"short_error":"UNAUTHENTICATED","error_code":401}')).toBe('UNAUTHENTICATED')
    expect(explainAgyError('AGY_ERROR: not json')).toBe('not json')
    expect(explainAgyError('something else')).toBeNull()
  })
})

describe('transcripts per agent', () => {
  it('folds a Codex run: messages, commands with output and exit status, edits, usage, a failed turn', async () => {
    const t = buildTranscript(await jsonl('codex-turn.jsonl'), 'codex')
    expect(t.map((i) => i.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'tool',
      'assistant',
      'result',
      'user',
      'assistant',
      'result'
    ])
    const [preflight, curl, edit] = t.filter((i) => i.kind === 'tool')
    expect(preflight).toMatchObject({ name: 'Bash', status: 'ok', output: expect.stringContaining('pdflatex') })
    expect(curl).toMatchObject({ status: 'error', output: expect.stringContaining('Could not resolve host') })
    expect(edit).toMatchObject({ name: 'Edit', summary: 'resume_data.json', status: 'ok' })
    const [first, second] = t.filter((i) => i.kind === 'result')
    expect(first).toMatchObject({ ok: true, usage: { inputTokens: 46909, outputTokens: 119 } })
    expect(second).toMatchObject({ ok: false, text: 'stream disconnected before completion' })
  })

  it('folds an Antigravity turn: streamed text, tools, refused actions, usage', async () => {
    const t = buildTranscript(await jsonl('agy-turn.jsonl'), 'antigravity')
    expect(t.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'assistant', 'result'])
    expect(t[1]).toMatchObject({ text: "I'll read the skill first." })
    const [view, curl, build] = t.filter((i) => i.kind === 'tool')
    expect(view).toMatchObject({ name: 'view_file', summary: 'SKILL.md', status: 'ok' })
    expect(curl).toMatchObject({ name: 'run_command', summary: 'curl https://example.com', status: 'error' })
    // Still running when the turn ended: interrupted.
    expect(build).toMatchObject({ status: 'error' })
    expect(t[t.length - 1]).toMatchObject({
      kind: 'result',
      ok: true,
      durationMs: 7500,
      denials: ['read_url_content https://example.com'],
      usage: { inputTokens: 12345, outputTokens: 400 }
    })
  })

  it('shows a used-up Antigravity quota as a failed turn', async () => {
    const t = buildTranscript(await jsonl('agy-quota.jsonl'), 'antigravity')
    expect(t).toEqual([expect.objectContaining({ kind: 'result', ok: false, text: expect.stringContaining('quota') })])
  })

  it('folds Claude runs when no agent is given (runs recorded before agents)', async () => {
    const events = await jsonl('read-file-turn.jsonl')
    expect(buildTranscript(events)).toEqual(buildTranscript(events, 'claude'))
    // The Claude events mean nothing to the other folds.
    expect(buildTranscript(events, 'codex').filter((i) => i.kind !== 'user' && i.kind !== 'notice')).toEqual([])
  })

  it('formats token usage', () => {
    expect(formatUsage({ inputTokens: 12345, outputTokens: 400 })).toBe('12.3k tokens in · 400 out')
    expect(formatUsage({ inputTokens: 250_000, outputTokens: 1500 })).toBe('250k tokens in · 1.5k out')
  })
})

describe('agent status', () => {
  const base = { cliPath: '/bin/x', version: '1.0.0', skillPath: '/s', skillTarget: '/t', claudeSkill: '/c' }

  it('is ready with the CLI and the skill', () => {
    expect(describeAgent({ ...base, id: 'codex' })).toMatchObject({ ready: true, problems: [], label: 'Codex' })
    // Without a search result, the only copy is the one found; nothing is chosen.
    expect(describeAgent({ ...base, id: 'codex' })).toMatchObject({ cliCandidates: ['/bin/x'], cliChoice: null, cliPinned: false })
    expect(describeAgent({ ...base, id: 'codex', cliPath: null })).toMatchObject({ cliCandidates: [], cliChoice: null })
  })

  it('says what is missing, per agent', () => {
    expect(describeAgent({ ...base, id: 'codex', cliPath: null, skillPath: null }).problems).toEqual([
      expect.stringContaining('codex CLI (Codex) was not found'),
      expect.stringContaining('"Install skill" for Codex')
    ])
    expect(describeAgent({ ...base, id: 'antigravity', skillPath: null, claudeSkill: null }).problems).toEqual([
      expect.stringContaining('Install the resume-tailor skill first')
    ])
    expect(describeAgent({ ...base, id: 'claude', auth: { loggedIn: false } }).problems).toEqual([
      expect.stringContaining('not signed in')
    ])
  })
})

describe('skill per agent', () => {
  let home: string
  let source: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'huntgry-skills-'))
    // The Claude copy, as a synced skill.
    source = join(home, '.claude/skills/synced/abc/resume-tailor')
    await mkdir(join(source, 'scripts'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '---\nname: resume-tailor\ndescription: x\n---\n')
  })
  afterEach(() => rm(home, { recursive: true, force: true }))

  it('finds the Claude copy anywhere below ~/.claude/skills', async () => {
    expect(await skillStatus('claude', home)).toEqual({ path: source, target: join(home, '.claude/skills/resume-tailor') })
  })

  it('does not count a nested copy for Codex (it only loads direct children)', async () => {
    await mkdir(join(home, '.agents/skills/synced/abc'), { recursive: true })
    await symlink(source, join(home, '.agents/skills/synced/abc/resume-tailor'))
    expect(await skillStatus('codex', home)).toEqual({ path: null, target: join(home, '.agents/skills/resume-tailor') })
  })

  it('links the Claude copy into the agent skills folder', async () => {
    const res = await installAgentSkill('codex', source, home)
    expect(res).toEqual({ ok: true, path: join(home, '.agents/skills/resume-tailor'), how: 'link' })
    expect(await readlink(res.path!)).toBe(await import('node:fs/promises').then((f) => f.realpath(source)))
    expect((await skillStatus('codex', home)).path).toBe(res.path)
    // Again: nothing to do.
    expect(await installAgentSkill('codex', source, home)).toMatchObject({ ok: true, how: 'present' })

    const agy = await installAgentSkill('antigravity', source, home)
    expect(agy).toMatchObject({ ok: true, path: join(home, '.gemini/antigravity-cli/skills/resume-tailor') })
  })

  it('accepts the IDE skills folder for Antigravity', async () => {
    await mkdir(join(home, '.gemini/config/skills/resume-tailor'), { recursive: true })
    await writeFile(join(home, '.gemini/config/skills/resume-tailor/SKILL.md'), 'x')
    expect((await skillStatus('antigravity', home)).path).toBe(join(home, '.gemini/config/skills/resume-tailor'))
  })

  it('copies when a link cannot be made', async () => {
    const res = await installAgentSkill('codex', source, home, {
      symlink: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
    })
    expect(res).toMatchObject({ ok: true, how: 'copy' })
    expect(await readFile(join(res.path!, 'SKILL.md'), 'utf8')).toContain('resume-tailor')
  })

  it('replaces its own dangling link', async () => {
    await mkdir(join(home, '.agents/skills'), { recursive: true })
    await symlink(join(home, 'gone'), join(home, '.agents/skills/resume-tailor'))
    expect(await installAgentSkill('codex', source, home)).toMatchObject({ ok: true, how: 'link' })
  })

  it('never replaces a folder that is not the skill', async () => {
    await mkdir(join(home, '.agents/skills/resume-tailor'), { recursive: true })
    await writeFile(join(home, '.agents/skills/resume-tailor/notes.txt'), 'mine')
    const res = await installAgentSkill('codex', source, home)
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('already exists') })
    expect(await readFile(join(home, '.agents/skills/resume-tailor/notes.txt'), 'utf8')).toBe('mine')
  })

  it('refuses without a Claude copy, and for Claude itself', async () => {
    expect(await installAgentSkill('codex', null, home)).toMatchObject({ ok: false, error: expect.stringContaining('first') })
    expect(await installAgentSkill('codex', join(home, 'nope'), home)).toMatchObject({ ok: false })
    expect(await installAgentSkill('claude', source, home)).toMatchObject({ ok: false })
  })
})
