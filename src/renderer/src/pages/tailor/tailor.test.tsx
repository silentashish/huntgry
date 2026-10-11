import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it } from 'vitest'
import type { AgentStatus, RunnerEnvironment, RunSummary, TranscriptItem } from '@shared/runner-types'
import { AgentPicker, agentLine } from '../../components/AgentPicker'
import { runEstimate, shortWhen } from './status'
import { groupTranscript, Transcript } from './Transcript'

const html = (node: React.ReactNode) => renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>)

describe('shortWhen', () => {
  const now = new Date(2026, 9, 11, 15, 0)
  it('reads today with the time, yesterday, then the date', () => {
    expect(shortWhen(new Date(2026, 9, 11, 10, 42).toISOString(), now)).toBe('today 10:42')
    expect(shortWhen(new Date(2026, 9, 10, 23, 59).toISOString(), now)).toBe('yesterday')
    expect(shortWhen(new Date(2026, 9, 2, 9, 0).toISOString(), now)).toBe('2 Oct')
    expect(shortWhen(new Date(2025, 11, 31, 9, 0).toISOString(), now)).toBe('31 Dec 2025')
    expect(shortWhen('not a date', now)).toBe('')
  })
})

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r',
  title: 'Staff Engineer · Acme',
  params: { coverLetter: false, dateStyle: 'right' },
  agent: 'claude',
  status: 'finished',
  sessionId: 's',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  outputFolder: null,
  outputFiles: [],
  costUsd: 0,
  live: false,
  ...over
})

const totals = (activeMs: number, estimatedCostUsd: number, unpricedTurns = 0): RunSummary['totals'] => ({
  turns: 2,
  activeMs,
  usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 },
  estimatedCostUsd,
  pricedTurns: 2 - unpricedTurns,
  unpricedTurns,
  incompleteTurns: 0
})

describe('runEstimate', () => {
  it('is the median time and cost of the agent’s measured runs, or nothing without one', () => {
    const runs = [
      run({ totals: totals(240_000, 0.4) }),
      run({ totals: totals(180_000, 0.3) }),
      run({ totals: totals(600_000, 0.9) }),
      run({ agent: 'codex', totals: totals(60_000, 0.1) }),
      run({ status: 'failed', totals: totals(10_000, 0.01) }),
      run({ totals: undefined })
    ]
    expect(runEstimate(runs, 'claude')).toBe('~4 min · ≈ $0.40 based on your last 3 Claude runs')
    expect(runEstimate(runs, 'codex')).toBe('~1 min · ≈ $0.10 based on your last Codex run')
    expect(runEstimate(runs, 'antigravity')).toBeNull()
    // Unpriced runs give a time but no cost.
    expect(runEstimate([run({ agent: 'antigravity', totals: totals(120_000, 0, 2) })], 'antigravity')).toBe(
      '~2 min based on your last Antigravity run'
    )
  })
})

describe('groupTranscript', () => {
  it('keeps user messages and notices apart and closes an agent block at its result', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'job' },
      { kind: 'assistant', id: 'a1', text: 'Reading' },
      { kind: 'tool', id: 't1', name: 'Read', summary: 'x.md', status: 'ok' },
      { kind: 'result', id: 'r1', ok: true, text: '', costUsd: 0, durationMs: 0, denials: [] },
      { kind: 'assistant', id: 'a2', text: 'More' },
      { kind: 'notice', id: 'n1', level: 'info', text: 'Stopped.' },
      { kind: 'user', id: 'u2', text: 'Approved' }
    ]
    expect(groupTranscript(items).map((b) => (b.kind === 'turn' ? b.items.map((i) => i.id) : b.id))).toEqual([
      'u1',
      ['a1', 't1', 'r1'],
      ['a2'],
      'n1',
      'u2'
    ])
  })

  it('names the agent on its blocks and shows the tool name as a chip', () => {
    const out = html(
      <Transcript
        agent="codex"
        items={[
          { kind: 'assistant', id: 'a1', text: 'Reading' },
          { kind: 'tool', id: 't1', name: 'Bash', summary: 'python3 build.py', status: 'running' }
        ]}
      />
    )
    expect(out).toContain('Codex')
    expect(out).toMatch(/>Bash</)
    expect(out).toContain('python3 build.py')
  })
})

const agentStatusOf = (over: Partial<AgentStatus>): AgentStatus => ({
  id: 'codex',
  label: 'Codex',
  cliPath: '/bin/codex',
  version: '0.48.0',
  cliCandidates: ['/bin/codex'],
  cliChoice: null,
  cliPinned: false,
  skillPath: '/skills/resume-tailor',
  skillTarget: '/skills/resume-tailor',
  ready: true,
  problems: [],
  ...over
})

const environment = (agents: AgentStatus[], loggedIn = true): RunnerEnvironment =>
  ({ defaultAgent: 'claude', agents, claudeAuth: { loggedIn } }) as unknown as RunnerEnvironment

describe('AgentPicker', () => {
  it('says what each agent can do on the detailed cards', () => {
    const env = environment([])
    expect(agentLine(env, agentStatusOf({}))).toBe('v0.48.0 · skill linked')
    expect(agentLine(env, agentStatusOf({ id: 'claude', version: '2.1.4' }))).toBe('v2.1.4 · signed in')
    expect(agentLine(environment([], false), agentStatusOf({ id: 'claude', version: '2.1.4', ready: false }))).toBe('v2.1.4 · not signed in')
    expect(agentLine(env, agentStatusOf({ cliPath: null, version: null, ready: false }))).toBe('not installed')
    expect(agentLine(env, agentStatusOf({ skillPath: null, ready: false }))).toBe('v0.48.0 · skill missing')
    expect(agentLine(null, undefined)).toBe('checking…')
  })

  it('renders one native radio per agent, named for the tests and screen readers', () => {
    const env = environment([
      agentStatusOf({ id: 'claude', label: 'Claude' }),
      agentStatusOf({}),
      agentStatusOf({ id: 'antigravity', label: 'Antigravity', ready: false, problems: ['The agy CLI was not found.'] })
    ])
    const out = html(<AgentPicker environment={env} value="codex" onChange={() => undefined} detailed />)
    expect(out.match(/<input[^>]*type="radio"/g)).toHaveLength(3)
    expect(out).toContain('aria-label="Claude (default)"')
    expect(out).toContain('aria-label="Antigravity: not available"')
    expect(out).toMatch(/<input[^>]*value="codex"[^>]*checked=""|<input[^>]*checked=""[^>]*value="codex"/)
  })
})
