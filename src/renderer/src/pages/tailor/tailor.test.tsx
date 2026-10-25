import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatus, RunnerEnvironment, RunSummary, TranscriptItem } from '@shared/runner-types'
import { AgentPicker, agentLine } from '../../components/AgentPicker'
import { NavigationContext, type Navigation } from '../../navigation'
import { RunView } from './RunView'
import { StartForm } from './StartForm'
import { runEstimate, shortWhen } from './status'
import { groupTranscript, Transcript } from './Transcript'

// The preload bridge (`window.api`) does not exist here; the views only call it from effects and clicks.
vi.mock('../../api', () => ({ api: {}, errorText: String }))

const nav: Navigation = {
  location: { page: 'tailor', params: undefined },
  navigate: () => undefined,
  setLeaveGuard: () => undefined
}

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <MantineProvider>
      <NavigationContext.Provider value={nav}>{node}</NavigationContext.Provider>
    </MantineProvider>
  )

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
      // Paused at the gap analysis: only part of the work, so it does not count.
      run({ status: 'waiting', totals: totals(30_000, 0.05) }),
      run({ status: 'stopped', totals: totals(20_000, 0.02) }),
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

describe('RunView reply dock', () => {
  const finish = /<button[^>]*>(?:(?!<\/button>).)*Finish conversation/s

  it('offers Finish conversation for a run waiting for the reply', () => {
    expect(html(<RunView run={run({ status: 'waiting', live: true })} events={[]} />)).toMatch(finish)
    // A waiting run with no process (Codex between turns) can be finished too.
    expect(html(<RunView run={run({ status: 'waiting', live: false })} events={[]} />)).toMatch(finish)
  })

  it('hides it while the agent works and for a run that cannot be ended', () => {
    const working = html(<RunView run={run({ status: 'running', live: true })} events={[]} />)
    expect(working).not.toMatch(finish)
    expect(working).toMatch(/>End</)
    const finished = html(<RunView run={run({ status: 'finished', live: false })} events={[]} />)
    expect(finished).not.toMatch(finish)
    expect(finished).not.toMatch(/>End</)
  })
})

describe('StartForm', () => {
  it('says the fields come from the saved job, with the description’s word count', () => {
    const out = html(
      <StartForm
        prefill={{ jobDescription: 'Acme is hiring a Staff Engineer. Go and Postgres.', jobUrl: 'https://acme.example/jobs/1', company: 'Acme', role: 'Staff Engineer' }}
        environment={null}
        busy={false}
        onStart={() => undefined}
        onEnvironmentChange={() => undefined}
      />
    )
    expect(out).toContain('Prefilled from your saved job')
    expect(out).toContain('Staff Engineer at Acme.')
    expect(out).toContain('(9 words)')
  })

  it('says every run goes to the end and lands in Review, with no approval stop (#158)', () => {
    const props = { environment: null, busy: false, onStart: () => undefined, onEnvironmentChange: () => undefined }
    const out = html(<StartForm prefill={undefined} {...props} />)
    expect(out).toContain('to the end, without stopping to ask')
    expect(out).toContain('Review page')
    expect(out).not.toMatch(/approve the wording|gap analysis/)
    // A pasted job is saved with its role and company; there is no job-id override any more.
    expect(out).toContain('Company')
    expect(out).not.toContain('Job id')
    // A saved job brings its own role and company.
    const saved = html(
      <StartForm prefill={{ jobDescription: 'Acme is hiring a Staff Engineer. Go and Postgres.', role: 'Staff Engineer', company: 'Acme', savedJobId: 'url:acme-1' }} {...props} />
    )
    expect(saved).not.toContain('>Company')
  })

  it('shows no prefill note for a job board summary or an empty form', () => {
    const props = { environment: null, busy: false, onStart: () => undefined, onEnvironmentChange: () => undefined }
    expect(html(<StartForm prefill={undefined} {...props} />)).not.toContain('Prefilled from')
    const summary = html(<StartForm prefill={{ jobDescription: 'Short snippet.', jobUrl: 'https://indeed.example/1', descriptionComplete: false }} {...props} />)
    expect(summary).not.toContain('Prefilled from')
    expect(summary).toContain('summary, not the full posting')
  })
})
