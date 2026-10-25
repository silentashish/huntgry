import { describe, expect, it } from 'vitest'
import type { CandidateInput } from '@shared/automation-select'
import {
  DEFAULT_AUTOMATION_SETTINGS,
  EMPTY_AUTOMATION_STATE,
  type AutomationLogEntry,
  type AutomationSettings,
  type AutomationState,
  type PreparedFill
} from '@shared/automation-types'
import type { ApplySession, FillReport } from '@shared/apply-types'
import { DEFAULT_FILTERS } from '@shared/job-filters'
import { profileSignals, scoreJob } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'
import { emptyExperience, emptyProfile } from '@shared/master-profile'
import { matchOf } from '@shared/automation-select'
import { Automation, PageBoundError, type AutomationDeps, type PageBudget, type PrepareOutcome, type TailorResult } from './service'
import type { CandidateSource } from './sources'

/** Local noon on 24 Oct 2026; the default window (22:00–07:00) is closed then. */
const NOON = new Date(2026, 9, 24, 12, 0).getTime()

const profile = (() => {
  const p = emptyProfile()
  p.contact.headline = 'Backend Engineer'
  p.skills = [{ category: 'Languages', items: ['Go', 'Python', 'TypeScript', 'PostgreSQL', 'AWS'] }]
  p.experience = [{ ...emptyExperience(), role: 'Senior Backend Engineer', start: 'Jan 2020', end: 'Present', technologies: 'Go, AWS' }]
  return p
})()
const SIGNALS = profileSignals(profile, new Date(NOON))

const HIGH = 'We use Go, Python, TypeScript, PostgreSQL and AWS every day.'
const LOW = 'We use Java, Spring, Kafka, Oracle and Go every day.'

let n = 0
const job = (over: Partial<Job> = {}): Job => ({
  id: `pasted:j${++n}`,
  source: 'pasted',
  sourceId: `j${n}`,
  title: 'Backend Engineer',
  company: `Company ${n}`,
  location: 'Remote',
  remote: true,
  salary: '',
  postedAt: '2026-10-23T00:00:00Z',
  url: `https://example.com/jobs/${n}`,
  boardUrl: null,
  description: HIGH,
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-23T00:00:00Z',
  ...over
})

const report = (url: string): FillReport => ({
  ats: 'generic',
  url,
  hasSubmitButton: true,
  fields: [
    { key: 'firstName', label: 'First name', kind: 'text', required: true, outcome: 'filled', value: 'Alex' },
    { key: 'resume', label: 'Resume', kind: 'file', required: true, outcome: 'to-upload' },
    { key: null, label: 'What interests you?', kind: 'textarea', required: false, outcome: 'filled', value: 'Fake draft', question: 'q', suggestedBy: 'draft' }
  ]
})

const until = async (pred: () => boolean, what = 'condition', ms = 3000) => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

interface Harness {
  automation: Automation
  deps: AutomationDeps
  state: () => AutomationState
  log: AutomationLogEntry[]
  jobs: Map<string, Job>
  calls: Record<string, string[]>
  setNow(ms: number): void
  settings: AutomationSettings
  tailorResults: Map<string, TailorResult | (() => Promise<TailorResult>)>
  prepareResults: Map<string, PrepareOutcome | (() => Promise<PrepareOutcome>)>
  failFetch: Set<string>
  failMaterialize: Set<string>
  prepared: Map<string, PreparedFill>
  flags: { applyBusy: boolean; tailorBlocked: string | null; workspace: string; median: number | null; connected: boolean; link: 'resolved' | 'signed-out' | 'no-link' | 'failed' | 'throw'; copies: number }
  trusted: Map<string, { enabled: boolean; day: { date: string; started: number } }>
  costs: Map<string, number>
}

function harness(opts: { jobs?: Job[]; rows?: Job[]; settings?: Partial<AutomationSettings>; initial?: AutomationState } = {}): Harness {
  let now = NOON
  let stored: AutomationState = opts.initial ? structuredClone(opts.initial) : structuredClone(EMPTY_AUTOMATION_STATE)
  const log: AutomationLogEntry[] = []
  const jobs = new Map<string, Job>()
  for (const j of opts.jobs ?? []) jobs.set(j.id, j)
  const rows = opts.rows ?? []
  const calls: Record<string, string[]> = { materialize: [], resolve: [], fetch: [], tailor: [], prepare: [], approve: [], markApplied: [], pause: [], resume: [], stop: [], start: [], dismiss: [] }
  const settings: AutomationSettings = { ...DEFAULT_AUTOMATION_SETTINGS, window: { mode: 'anytime' }, ...opts.settings }
  const tailorResults = new Map<string, TailorResult | (() => Promise<TailorResult>)>()
  const prepareResults = new Map<string, PrepareOutcome | (() => Promise<PrepareOutcome>)>()
  const failFetch = new Set<string>()
  const failMaterialize = new Set<string>()
  const prepared = new Map<string, PreparedFill>()
  const flags = {
    applyBusy: false,
    tailorBlocked: null as string | null,
    workspace: '/ws',
    median: 1 as number | null,
    connected: true,
    link: 'resolved' as Harness['flags']['link'],
    // Jobright pages one lookup or fetch loads (aliases).
    copies: 1
  }
  const items = new Map<string, string>()
  const itemState = new Map<string, TailorResult | 'working'>()
  const trusted = new Map<string, { enabled: boolean; day: { date: string; started: number } }>()
  const costs = new Map<string, number>()
  /** A Jobright page through the run's allowance, like the app's counted loader. */
  const load = (pages: PageBudget) => {
    for (let i = 0; i < flags.copies; i++) if (!pages.take()) throw new PageBoundError()
  }

  const jobsSource: CandidateSource = {
    id: 'jobs',
    list: async () => [...jobs.values()].map((j) => ({ key: j.id, source: 'jobs', job: j, savedJobId: j.id, scoreable: !!j.description })),
    materialize: async (_ws, input) => input.savedJobId ?? input.job.id
  }
  const exploreSource: CandidateSource = {
    id: 'explore',
    list: async () =>
      rows.map((r): CandidateInput => {
        const saved = jobs.get(r.id)
        return saved
          ? { key: saved.id, source: 'explore', job: saved, savedJobId: saved.id, scoreable: !!saved.description }
          : { key: `explore:${r.sourceId}`, source: 'explore', job: { ...r, description: '' }, scoreable: false }
      }),
    materialize: async (_ws, input) => {
      calls.materialize.push(input.key)
      if (failMaterialize.has(input.key)) throw new Error('This job is no longer on the Jobright list.')
      const row = rows.find((r) => `explore:${r.sourceId}` === input.key)!
      // Saved with the Jobright page as its link and no description yet.
      jobs.set(row.id, { ...row, description: '', descriptionComplete: false, url: row.boardUrl ?? row.url })
      return row.id
    }
  }

  const deps: AutomationDeps = {
    workspace: async () => flags.workspace,
    settings: async () => settings,
    sources: (s) => [s.sources.jobs ? jobsSource : null, s.sources.explore ? exploreSource : null].filter((x): x is CandidateSource => !!x),
    selection: async () => ({ signals: SIGNALS, filters: DEFAULT_FILTERS, applications: [] }),
    findJob: async (_ws, id) => jobs.get(id) ?? null,
    linkConnected: async () => flags.connected,
    onJobright: (j) => j.source === 'jobright' && !!j.boardUrl && j.url === j.boardUrl,
    resolveLink: async (_ws, id, pages) => {
      calls.resolve.push(id)
      load(pages)
      if (flags.link === 'throw') throw new Error('network down')
      if (flags.link !== 'resolved') return flags.link
      const j = jobs.get(id)!
      jobs.set(id, { ...j, url: `https://employer.example.com/${j.sourceId}` })
      return 'resolved'
    },
    fetchDetails: async (_ws, id, pages) => {
      calls.fetch.push(id)
      const j = jobs.get(id)!
      if (j.source === 'jobright') load(pages)
      if (failFetch.has(id)) throw new Error('The page did not load.')
      const full = { ...j, description: (j as Job & { full?: string }).full ?? HIGH, descriptionComplete: true }
      jobs.set(id, full)
      return full
    },
    score: async (_ws, j) => {
      const s = scoreJob(j, SIGNALS, new Date(now))
      return { ...(s.excluded ? { excluded: s.excluded } : {}), match: matchOf(s.match) }
    },
    tailor: {
      blocked: () => flags.tailorBlocked,
      start: async (_ws, jobId) => {
        calls.tailor.push(jobId)
        const itemId = `q-${jobId}`
        items.set(itemId, jobId)
        return { itemId }
      },
      wait: async (itemId, signal) => {
        const jobId = items.get(itemId)!
        const r = tailorResults.get(jobId)
        const fallback: TailorResult = { status: 'done', outcome: 'unreviewed', applicationId: `role/co/${jobId}`, runId: `run-${jobId}` }
        const result = typeof r === 'function' ? r() : Promise.resolve(r ?? fallback)
        return Promise.race([
          result,
          new Promise<TailorResult>((resolve) => {
            if (signal.aborted) resolve({ status: 'cancelled', aborted: true })
            signal.addEventListener('abort', () => resolve({ status: 'cancelled', aborted: true }))
          })
        ])
      },
      item: (itemId) => itemState.get(itemId) ?? null,
      pause: async () => void calls.pause.push('pause'),
      resume: async () => void calls.resume.push('resume'),
      stop: async () => void calls.stop.push('stop'),
      medianCostUsd: async () => flags.median,
      costUsd: async (_ws, itemId) => costs.get(itemId) ?? 1.25
    },
    apply: {
      busy: () => flags.applyBusy,
      prepare: async (applicationId) => {
        calls.prepare.push(applicationId)
        const r = prepareResults.get(applicationId)
        if (typeof r === 'function') return r()
        return (
          r ?? {
            ok: true,
            fill: { url: 'https://employer.example.com/apply', report: report('https://employer.example.com/apply'), drafts: { q: 'Fake draft' }, aiOnce: {}, mappedSteps: ['s'], draftedSteps: ['s'], asked: ['q'] }
          }
        )
      },
      start: async (applicationId, seed) => {
        calls.start.push(`${applicationId}:${JSON.stringify(seed.drafts)}`)
        return { id: 'session-1', applicationId, status: 'filled' } as ApplySession
      }
    },
    approve: async (_ws, id) => void calls.approve.push(id),
    markApplied: async (_ws, id) => void calls.markApplied.push(id),
    dismissJob: async (_ws, id) => void calls.dismiss.push(id),
    readState: async () => structuredClone(stored),
    writeState: async (_ws, s) => {
      stored = structuredClone(s)
    },
    readTrusted: async (ws) => structuredClone(trusted.get(ws) ?? null),
    writeTrusted: async (ws, usage) => void trusted.set(ws, structuredClone(usage)),
    appendLog: async (_ws, e) => void log.push(e),
    writePrepared: async (_ws, f) => void prepared.set(f.applicationId, f),
    readPrepared: async (_ws, id) => prepared.get(id) ?? null,
    emit: () => undefined,
    emitStep: () => undefined,
    now: () => now,
    tickMs: 5
  }
  const automation = new Automation(deps)
  return {
    automation,
    deps,
    state: () => stored,
    log,
    jobs,
    calls,
    setNow: (ms) => {
      now = ms
    },
    settings,
    tailorResults,
    prepareResults,
    failFetch,
    failMaterialize,
    prepared,
    flags,
    trusted,
    costs
  }
}

const idle = (h: Harness) => until(() => h.state().run === null && h.state().lastRun !== null, 'the run to end')
const stepsOf = (h: Harness, key: string) => h.log.filter((e) => e.key === key).map((e) => `${e.step}:${e.outcome}`)
const totalCalls = (h: Harness) => Object.values(h.calls).reduce((sum, c) => sum + c.length, 0)

/** An Explore row: a Jobright job whose link is still the Jobright page. */
const row = (over: Partial<Job> & { full?: string } = {}) => {
  const id = `r${++n}`
  return job({
    id: `jobright:${id}`,
    source: 'jobright',
    sourceId: id,
    url: `https://jobright.ai/jobs/info/${id}`,
    boardUrl: `https://jobright.ai/jobs/info/${id}`,
    description: '',
    descriptionComplete: false,
    ...over
  })
}

describe('Automation: a job through every step', () => {
  it('a saved high-match job goes description → scoring → tailoring → filling → Ready to submit', async () => {
    const j = job({ descriptionComplete: false, description: HIGH })
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    await h.automation.runNow()
    await idle(h)
    const c = h.state().candidates[j.id]
    expect(c.step).toBe('ready')
    expect(c.applicationId).toBe(`role/co/${j.id}`)
    expect(c.prepared).toMatchObject({ filled: 2, ai: 1, uploadsDeferred: 1, openRequired: 0 })
    expect(c.costUsd).toBe(1.25)
    expect(h.state().day.started).toBe(1)
    expect(h.state().lastRun).toMatchObject({ status: 'finished', costUsd: 1.25 })
    expect(stepsOf(h, j.id)).toEqual([
      'description:start',
      'description:ok',
      'scoring:start',
      'scoring:ok',
      'tailoring:start',
      'tailoring:ok',
      'filling:start',
      'filling:ok'
    ])
    expect(h.prepared.get(c.applicationId!)?.drafts).toEqual({ q: 'Fake draft' })
    // Only existing services: the fetch, one pipeline start, one prepare.
    expect(h.calls.fetch).toEqual([j.id])
    expect(h.calls.tailor).toEqual([j.id])
    expect(h.calls.prepare).toEqual([c.applicationId])
  })

  it('an Explore row is saved, its employer link resolved, its posting read and scored, then prepared', async () => {
    const r = row()
    const h = harness({ rows: [r], settings: { sources: { jobs: false, explore: true } } })
    await h.automation.runNow()
    await idle(h)
    expect(h.state().candidates[`explore:${r.sourceId}`]).toBeUndefined()
    const c = h.state().candidates[r.id]
    expect(c.step).toBe('ready')
    expect(c.jobId).toBe(r.id)
    // Saving starts under the row's key; from then on the job is logged under its saved id.
    expect(stepsOf(h, `explore:${r.sourceId}`)).toEqual(['saving:start'])
    expect(stepsOf(h, r.id).filter((s) => s.endsWith(':start'))).toEqual([ 'link:start', 'description:start', 'scoring:start', 'tailoring:start', 'filling:start'])
    expect(h.calls.resolve).toEqual([r.id])
    // The link and the description: two Jobright pages (saving loads none; the link step looks it up).
    expect(h.state().lastRun?.pageLoads).toBe(2)
  })

  it('an Explore row whose full posting scores below the threshold is skipped for good, never tailored', async () => {
    const r = row({ full: LOW } as Partial<Job>)
    const h = harness({ rows: [r], settings: { sources: { jobs: false, explore: true } } })
    h.jobs.set(r.id, { ...r, description: '', descriptionComplete: false })
    ;(h.jobs.get(r.id) as Job & { full?: string }).full = LOW
    await h.automation.runNow()
    await idle(h)
    const c = h.state().candidates[r.id]
    expect(c.step).toBe('skipped')
    expect(c.final).toBe(true)
    expect(c.reasons[0]).toMatch(/below 80|requirement/)
    expect(h.calls.tailor).toEqual([])
    // The next run leaves it alone (no page is loaded again).
    const before = h.calls.fetch.length
    await h.automation.runNow()
    await idle(h)
    expect(h.calls.fetch.length).toBe(before)
  })

  it('stops at the page-load bound: the rest of the Explore rows wait for the next run', async () => {
    const rows = [row(), row()]
    const h = harness({ rows, settings: { sources: { jobs: false, explore: true }, maxExplorePageLoads: 3 } })
    await h.automation.runNow()
    await idle(h)
    const steps = rows.map((r) => h.state().candidates[r.id]?.step ?? h.state().candidates[`explore:${r.sourceId}`]?.step)
    expect(steps.sort()).toEqual(['ready', 'selected'])
  })
})

describe('Automation: a failed step needs you, and is never retried by itself', () => {
  const cases: Array<{ name: string; failedStep: string; setup(h: Harness, key: string, j: Job): void; error: RegExp }> = [
    {
      name: 'saving the Explore row',
      failedStep: 'saving',
      setup: (h, key) => h.failMaterialize.add(key),
      error: /Couldn't save it to Jobs/
    },
    {
      name: 'the description',
      failedStep: 'description',
      setup: (h, _key, j) => h.failFetch.add(j.id),
      error: /Couldn't read the description: The page did not load/
    },
    {
      name: 'tailoring that failed',
      failedStep: 'tailoring',
      setup: (h, _key, j) => h.tailorResults.set(j.id, { status: 'failed', error: 'The agent crashed.' }),
      error: /Tailoring failed: The agent crashed/
    },
    {
      name: 'tailoring that needs attention',
      failedStep: 'tailoring',
      setup: (h, _key, j) => h.tailorResults.set(j.id, { status: 'done', outcome: 'needs-attention', applicationId: `role/co/${j.id}`, runId: 'r' }),
      error: /needs attention/
    },
    {
      name: 'a fill that stops at a wall',
      failedStep: 'filling',
      setup: (h, _key, j) => h.prepareResults.set(`role/co/${j.id}`, { ok: false, status: 'waiting', message: 'This is the job posting. Press "Apply" in the page yourself.' }),
      error: /job posting/
    },
    {
      name: 'a fill blocked by a bot check',
      failedStep: 'filling',
      setup: (h, _key, j) => h.prepareResults.set(`role/co/${j.id}`, { ok: false, status: 'blocked', message: 'The site asked for a human check.' }),
      error: /human check/
    },
    {
      name: 'a fill that timed out',
      failedStep: 'filling',
      setup: (h, _key, j) => h.prepareResults.set(`role/co/${j.id}`, { ok: false, status: 'timeout', message: 'The form did not finish filling in time.' }),
      error: /in time/
    }
  ]

  for (const t of cases) {
    it(`${t.name}: Needs you with the step and reason, logged once, untouched by 3 more ticks and runs`, async () => {
      const r = row()
      const h = harness({ rows: [r], settings: { sources: { jobs: false, explore: true } } })
      const key = `explore:${r.sourceId}`
      t.setup(h, key, r)
      await h.automation.runNow()
      await idle(h)
      const c = h.state().candidates[r.id] ?? h.state().candidates[key]
      expect(c.step).toBe('needs-you')
      expect(c.failedStep).toBe(t.failedStep)
      expect(c.error).toMatch(t.error)
      expect(h.log.filter((e) => e.outcome === 'fail')).toHaveLength(1)
      const calls = totalCalls(h)
      for (let i = 0; i < 3; i++) {
        await h.automation.tick()
        await h.automation.runNow()
        await idle(h)
      }
      expect(totalCalls(h)).toBe(calls)
      expect((h.state().candidates[r.id] ?? h.state().candidates[key]).step).toBe('needs-you')
      expect(h.log.filter((e) => e.outcome === 'fail')).toHaveLength(1)
    })
  }

  it('Retry makes exactly one more attempt, from the failed step', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.prepareResults.set(`role/co/${j.id}`, { ok: false, status: 'blocked', message: 'The site asked for a human check.' })
    await h.automation.runNow()
    await idle(h)
    expect(h.state().candidates[j.id].step).toBe('needs-you')
    expect(h.calls.tailor).toHaveLength(1)
    expect(h.calls.prepare).toHaveLength(1)

    // Still blocked: one more fill, no new tailoring, Needs you again.
    await h.automation.retry(j.id)
    await until(() => h.state().run === null, 'the retry run')
    expect(h.calls.tailor).toHaveLength(1)
    expect(h.calls.prepare).toHaveLength(2)
    expect(h.state().candidates[j.id].step).toBe('needs-you')
    for (let i = 0; i < 3; i++) await h.automation.tick()
    expect(h.calls.prepare).toHaveLength(2)

    // Passes now: Ready to submit.
    h.prepareResults.delete(`role/co/${j.id}`)
    await h.automation.retry(j.id)
    await until(() => h.state().run === null && h.state().candidates[j.id].step === 'ready', 'ready')
    expect(h.calls.prepare).toHaveLength(3)
    await expect(h.automation.retry(j.id)).rejects.toThrow(/needs you/)
  })

  it('a run interrupted by a quit ends, and its job mid-step needs you ("Interrupted")', async () => {
    const initial: AutomationState = structuredClone(EMPTY_AUTOMATION_STATE)
    initial.run = { id: 'a-1', startedAt: new Date(NOON).toISOString(), status: 'running', trigger: 'now', costUsd: 0, pageLoads: 0, candidates: ['pasted:x'], current: 'pasted:x' }
    initial.candidates['pasted:x'] = { key: 'pasted:x', jobId: 'pasted:x', source: 'jobs', title: 'T', company: 'C', reasons: [], step: 'description', updatedAt: 'x' }
    const h = harness({ initial })
    await h.automation.init()
    h.automation.shutdown()
    expect(h.state().run).toBeNull()
    expect(h.state().lastRun).toMatchObject({ status: 'stopped', message: expect.stringMatching(/Interrupted/) })
    expect(h.state().candidates['pasted:x']).toMatchObject({ step: 'needs-you', failedStep: 'description', error: expect.stringMatching(/Interrupted/) })
  })
})

describe('Automation: caps', () => {
  it('cost: stops before a launch that would go over the cap; the jobs not started stay Selected', async () => {
    const jobs = [job(), job(), job()]
    const h = harness({ jobs, settings: { sources: { jobs: true, explore: false }, maxCostUsd: 4 } })
    // Each run costs 1.25 and the median says ~1.5: 0+1.5, 1.25+1.5 and 2.5+1.5 fit in 4, 3.75+1.5 would not.
    h.flags.median = 1.5
    const four = [...jobs, job()]
    for (const j of four.slice(3)) h.jobs.set(j.id, j)
    await h.automation.runNow()
    await idle(h)
    expect(h.state().lastRun).toMatchObject({ status: 'stopped-cost', costUsd: 3.75 })
    expect(h.calls.tailor).toHaveLength(3)
    const steps = Object.values(h.state().candidates).map((c) => c.step).sort()
    expect(steps).toEqual(['ready', 'ready', 'ready', 'selected'])
    expect(h.log.some((e) => e.outcome === 'skip' && /Cost cap/.test(e.message))).toBe(true)
  })

  it('per day: Explore rows that pass scoring stop at the daily cap when they reach tailoring', async () => {
    const rows = [row(), row()]
    const h = harness({ rows, settings: { sources: { jobs: false, explore: true }, perDay: 1 } })
    await h.automation.runNow()
    await idle(h)
    expect(h.calls.tailor).toHaveLength(1)
    expect(h.state().lastRun?.status).toBe('stopped-cap')
    const skipped = Object.values(h.state().candidates).find((c) => c.step === 'skipped')
    expect(skipped?.reasons[0]).toBe('Cap: 1 a day.')
    expect(h.state().day.started).toBe(1)
  })
})

describe('Automation: controls and coexistence', () => {
  it('pause holds before the next step and pauses its pipeline; resume continues', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    let finish: (r: TailorResult) => void = () => undefined
    h.tailorResults.set(j.id, () => new Promise((resolve) => (finish = resolve)))
    await h.automation.runNow()
    await until(() => h.state().candidates[j.id]?.step === 'tailoring', 'tailoring')
    await h.automation.pause()
    expect(h.calls.pause).toEqual(['pause'])
    finish({ status: 'done', outcome: 'unreviewed', applicationId: `role/co/${j.id}`, runId: 'r' })
    await until(() => h.state().run?.status === 'paused' && h.log.some((e) => e.step === 'tailoring' && e.outcome === 'ok'), 'held')
    await new Promise((r) => setTimeout(r, 30))
    expect(h.calls.prepare).toEqual([])
    await h.automation.resume()
    expect(h.calls.resume).toEqual(['resume'])
    await idle(h)
    expect(h.state().candidates[j.id].step).toBe('ready')
  })

  it('the run window: starts only while open, once per opening, holds when it closes and continues when it opens', async () => {
    const j1 = job()
    const j2 = job()
    const h = harness({ jobs: [j1], settings: { sources: { jobs: true, explore: false }, window: { mode: 'window', start: '22:00', end: '07:00' } } })
    await h.automation.setEnabled(true)
    // Noon: closed; the page shows the next opening.
    await h.automation.tick()
    expect(h.state().run).toBeNull()
    expect((await h.automation.getState()).nextWindowAt).toBe(new Date(2026, 9, 24, 22, 0).toISOString())

    // 22:00: a run starts; the first job is held by tailoring while the window closes.
    let finish: (r: TailorResult) => void = () => undefined
    h.tailorResults.set(j1.id, () => new Promise((resolve) => (finish = resolve)))
    h.setNow(new Date(2026, 9, 24, 22, 0).getTime())
    await h.automation.tick()
    await until(() => h.state().candidates[j1.id]?.step === 'tailoring', 'tailoring')
    h.setNow(new Date(2026, 9, 25, 7, 0).getTime())
    finish({ status: 'done', outcome: 'unreviewed', applicationId: `role/co/${j1.id}`, runId: 'r' })
    await until(() => h.state().run?.status === 'waiting', 'waiting for the window')
    expect(h.state().run?.message).toMatch(/run window closed/)
    expect(h.calls.prepare).toEqual([])

    // 22:00 the next day: it continues.
    h.setNow(new Date(2026, 9, 25, 22, 0).getTime())
    await h.automation.tick()
    await idle(h)
    expect(h.state().candidates[j1.id].step).toBe('ready')
    expect(h.state().lastRun?.trigger).toBe('window')

    // Same opening: a new job does not start a second run until the next opening.
    h.jobs.set(j2.id, j2)
    await h.automation.tick()
    expect(h.state().run).toBeNull()
    expect(h.calls.tailor).toHaveLength(1)
    h.setNow(new Date(2026, 9, 26, 22, 30).getTime())
    await h.automation.tick()
    await idle(h)
    expect(h.calls.tailor).toHaveLength(2)
  })

  it('Run now ignores the window but not the caps', async () => {
    const jobs = [job(), job()]
    const h = harness({ jobs, settings: { sources: { jobs: true, explore: false }, window: { mode: 'window', start: '22:00', end: '07:00' }, perDay: 1 } })
    await h.automation.runNow()
    await idle(h)
    expect(h.calls.tailor).toHaveLength(1)
    expect(Object.values(h.state().candidates).map((c) => c.step).sort()).toEqual(['ready', 'skipped'])
  })

  it('waits while another pipeline runs, and while the user has an apply session; never ends theirs', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.flags.tailorBlocked = 'Waiting for the running pipeline to finish.'
    h.flags.applyBusy = true
    await h.automation.runNow()
    await until(() => h.state().run?.status === 'waiting', 'waiting for the pipeline')
    expect(h.state().run?.message).toBe('Waiting for the running pipeline to finish.')
    expect(h.calls.tailor).toEqual([])
    h.flags.tailorBlocked = null
    await until(() => h.state().run?.message === 'Waiting for your apply session to end.', 'waiting for the session')
    expect(h.calls.prepare).toEqual([])
    h.flags.applyBusy = false
    await idle(h)
    expect(h.state().candidates[j.id].step).toBe('ready')
    expect(h.log.filter((e) => e.outcome === 'fail')).toEqual([])
  })

  it('a workspace switch stops the run', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.flags.tailorBlocked = 'Waiting for the running pipeline to finish.'
    await h.automation.runNow()
    await until(() => h.state().run?.status === 'waiting', 'waiting')
    h.flags.workspace = '/other'
    await until(() => h.state().run === null, 'stopped')
    expect(h.state().lastRun).toMatchObject({ status: 'stopped', message: 'Stopped: the workspace changed.' })
    expect(h.calls.tailor).toEqual([])
  })

  it('Stop ends the run; a job being tailored goes back to Selected', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.tailorResults.set(j.id, () => new Promise((resolve) => setTimeout(() => resolve({ status: 'cancelled' }), 20)))
    await h.automation.runNow()
    await until(() => h.state().candidates[j.id]?.step === 'tailoring', 'tailoring')
    await h.automation.stop()
    expect(h.calls.stop).toEqual(['stop'])
    await idle(h)
    expect(h.state().candidates[j.id].step).toBe('selected')
    expect(h.state().lastRun?.status).toBe('stopped')
  })
})

describe('Automation: Ready to submit', () => {
  it('Review & submit approves through the review service, opens the session with the prepared answers, and the confirmation records it', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    await h.automation.runNow()
    await idle(h)
    const appId = `role/co/${j.id}`
    await h.automation.openPrepared(j.id)
    expect(h.calls.approve).toEqual([appId])
    expect(h.calls.start).toEqual([`${appId}:{"q":"Fake draft"}`])
    // Another session's confirmation is not this one's.
    await h.automation.onApplySession({ id: 'other', applicationId: appId, status: 'submitted-detected' } as ApplySession)
    expect(h.calls.markApplied).toEqual([])
    await h.automation.onApplySession({ id: 'session-1', applicationId: appId, status: 'submitted-detected' } as ApplySession)
    expect(h.calls.markApplied).toEqual([appId])
    expect(h.state().candidates[j.id].step).toBe('submitted')
  })

  it('refuses to open a job that is not ready, and Dismiss drops it from the run for good', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.prepareResults.set(`role/co/${j.id}`, { ok: false, status: 'blocked', message: 'Bot check' })
    await h.automation.runNow()
    await idle(h)
    await expect(h.automation.openPrepared(j.id)).rejects.toThrow(/not ready/)
    await h.automation.dismiss(j.id)
    expect(h.calls.dismiss).toEqual([j.id])
    expect(h.state().candidates[j.id]).toMatchObject({ step: 'skipped', final: true, reasons: ['Dismissed by you.'] })
  })

  it('preview picks without loading or changing anything', async () => {
    const j = job()
    const low = job({ description: LOW })
    const h = harness({ jobs: [j, low], settings: { sources: { jobs: true, explore: false } } })
    const preview = await h.automation.preview()
    expect(preview.picked.map((c) => c.key)).toEqual([j.id])
    expect(preview.skipped.map((c) => c.key)).toEqual([low.id])
    expect(totalCalls(h)).toBe(0)
    expect(h.state().candidates).toEqual({})
  })
})

describe('Automation: review fixes (#173)', () => {
  it('two Run now at once start one run, and the job is tailored once', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    await h.automation.getState()
    await Promise.all([h.automation.runNow(), h.automation.runNow(), h.automation.tick()])
    await idle(h)
    expect(h.calls.tailor).toEqual([j.id])
    expect(h.log.filter((e) => e.step === 'run' && e.outcome === 'start')).toHaveLength(1)
  })

  it('Pause pressed while waiting for another pipeline holds the launch after the pipeline is gone', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.flags.tailorBlocked = 'Waiting for the running pipeline to finish.'
    await h.automation.runNow()
    await until(() => h.state().run?.status === 'waiting', 'waiting')
    await h.automation.pause()
    h.flags.tailorBlocked = null
    h.automation.wake()
    await until(() => h.state().run?.status === 'paused', 'paused')
    await new Promise((r) => setTimeout(r, 30))
    expect(h.calls.tailor).toEqual([])
    await h.automation.resume()
    await idle(h)
    expect(h.calls.tailor).toEqual([j.id])
  })

  it('Pause pressed while waiting for the user’s apply session holds the fill', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.flags.applyBusy = true
    await h.automation.runNow()
    await until(() => h.state().run?.message === 'Waiting for your apply session to end.', 'waiting for the session')
    await h.automation.pause()
    h.flags.applyBusy = false
    h.automation.wake()
    await new Promise((r) => setTimeout(r, 30))
    expect(h.calls.prepare).toEqual([])
    await h.automation.resume()
    await idle(h)
    expect(h.calls.prepare).toHaveLength(1)
  })

  it('a launch after a wait across midnight is charged to the new day', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.flags.tailorBlocked = 'Waiting for the running pipeline to finish.'
    h.setNow(new Date(2026, 9, 24, 23, 59).getTime())
    await h.automation.runNow()
    await until(() => h.state().run?.status === 'waiting', 'waiting')
    h.setNow(new Date(2026, 9, 25, 0, 5).getTime())
    h.flags.tailorBlocked = null
    h.automation.wake()
    await idle(h)
    expect(h.state().day).toEqual({ date: '2026-10-25', started: 1 })
    expect(h.trusted.get('/ws')?.day).toEqual({ date: '2026-10-25', started: 1 })
  })

  it('Retry respects the company cap at launch, keeping its place in Needs you', async () => {
    const j = job({ company: 'Acme' })
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false }, perCompany: 2 } })
    h.failFetch.add(j.id)
    h.jobs.set(j.id, { ...j, descriptionComplete: false })
    await h.automation.runNow()
    await idle(h)
    expect(h.state().candidates[j.id].step).toBe('needs-you')
    // Meanwhile two Acme jobs became ready.
    const s = h.state()
    for (const k of ['r1', 'r2']) s.candidates[k] = { key: k, source: 'jobs', title: 'X', company: 'Acme', reasons: [], step: 'ready', applicationId: `a/acme/${k}`, updatedAt: new Date(NOON).toISOString() }
    const h2 = harness({ jobs: [h.jobs.get(j.id)!], settings: { sources: { jobs: true, explore: false }, perCompany: 2 }, initial: s })
    await h2.automation.retry(j.id)
    await until(() => h2.state().run === null, 'the retry run')
    expect(h2.calls.fetch).toEqual([j.id])
    expect(h2.calls.tailor).toEqual([])
    expect(h2.state().candidates[j.id]).toMatchObject({ step: 'needs-you', failedStep: 'tailoring', error: expect.stringMatching(/Cap: 2 per company/) })
  })

  it('the Jobright allowance is checked at every page: 1 page lets the link through and holds the description', async () => {
    const r = row()
    const h = harness({ rows: [r], settings: { sources: { jobs: false, explore: true }, maxExplorePageLoads: 1 } })
    await h.automation.runNow()
    await idle(h)
    expect(h.state().lastRun?.pageLoads).toBe(1)
    const c = h.state().candidates[r.id]
    expect(c.step).toBe('selected')
    expect(c.reasons[0]).toMatch(/at most 1 Jobright pages per run/)
    expect(h.calls.fetch).toEqual([])
    // The next run carries on from the description, with a fresh allowance.
    await h.automation.runNow()
    await idle(h)
    expect(h.state().candidates[r.id].step).toBe('ready')
    expect(h.calls.resolve).toEqual([r.id])
  })

  it('an allowance of 0 loads no Jobright page; a lookup with two Jobright copies that runs out mid-way waits too', async () => {
    const r = row()
    const h = harness({ rows: [r], settings: { sources: { jobs: false, explore: true }, maxExplorePageLoads: 0 } })
    await h.automation.runNow()
    await idle(h)
    expect(h.state().lastRun?.pageLoads).toBe(0)
    expect(h.calls.resolve).toEqual([])
    expect(h.state().candidates[r.id].step).toBe('selected')

    const r2 = row()
    const h2 = harness({ rows: [r2], settings: { sources: { jobs: false, explore: true }, maxExplorePageLoads: 1 } })
    h2.flags.copies = 2
    await h2.automation.runNow()
    await idle(h2)
    expect(h2.state().lastRun?.pageLoads).toBe(1)
    expect(h2.state().candidates[r2.id]).toMatchObject({ step: 'selected' })
    expect(h2.log.some((e) => e.outcome === 'fail')).toBe(false)
  })

  it('a failed employer-link lookup needs you; signed out or no link goes on', async () => {
    for (const [link, step] of [['failed', 'needs-you'], ['throw', 'needs-you'], ['signed-out', 'ready'], ['no-link', 'ready']] as const) {
      const r = row()
      const h = harness({ rows: [r], settings: { sources: { jobs: false, explore: true } } })
      h.flags.link = link
      await h.automation.runNow()
      await idle(h)
      const c = h.state().candidates[r.id]
      expect(c.step, link).toBe(step)
      if (step === 'needs-you') {
        expect(c.failedStep).toBe('link')
        expect(h.calls.tailor).toEqual([])
        const calls = totalCalls(h)
        for (let i = 0; i < 3; i++) {
          await h.automation.tick()
          await h.automation.runNow()
          await idle(h)
        }
        expect(totalCalls(h)).toBe(calls)
      }
    }
  })

  it('the window closing during tailoring holds the pipeline; it resumes at the next opening', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false }, window: { mode: 'window', start: '22:00', end: '07:00' } } })
    await h.automation.setEnabled(true)
    let finish: (r: TailorResult) => void = () => undefined
    h.tailorResults.set(j.id, () => new Promise((resolve) => (finish = resolve)))
    h.setNow(new Date(2026, 9, 24, 23, 0).getTime())
    await h.automation.tick()
    await until(() => h.state().candidates[j.id]?.step === 'tailoring', 'tailoring')
    h.setNow(new Date(2026, 9, 25, 7, 30).getTime())
    h.automation.wake()
    await until(() => h.calls.pause.length === 1, 'pipeline paused')
    expect(h.state().run?.status).toBe('waiting')
    h.setNow(new Date(2026, 9, 25, 22, 10).getTime())
    h.automation.wake()
    await until(() => h.calls.resume.length === 1, 'pipeline resumed')
    finish({ status: 'done', outcome: 'unreviewed', applicationId: `role/co/${j.id}`, runId: 'r' })
    await idle(h)
    expect(h.state().candidates[j.id].step).toBe('ready')
  })

  it('a job interrupted while tailoring needs you, and Retry follows its queue item instead of tailoring again', async () => {
    const initial: AutomationState = structuredClone(EMPTY_AUTOMATION_STATE)
    const j = job()
    initial.candidates[j.id] = { key: j.id, jobId: j.id, source: 'jobs', title: j.title, company: j.company, reasons: [], step: 'tailoring', queueItemId: 'q-old', updatedAt: 'x' }
    const h = harness({ jobs: [j], initial })
    await h.automation.getState()
    expect(h.state().candidates[j.id]).toMatchObject({ step: 'needs-you', failedStep: 'tailoring', queueItemId: 'q-old' })
    // The queue finished that job meanwhile.
    ;(h.deps.tailor as { item: (id: string) => unknown }).item = () => ({ status: 'done', outcome: 'unreviewed', applicationId: `role/co/${j.id}`, runId: 'r-old' })
    const wait = h.deps.tailor.wait
    h.deps.tailor.wait = async (id, signal) =>
      id === 'q-old' ? { status: 'done', outcome: 'unreviewed', applicationId: `role/co/${j.id}`, runId: 'r-old' } : wait(id, signal)
    await h.automation.retry(j.id)
    await until(() => h.state().run === null && h.state().candidates[j.id].step === 'ready', 'ready')
    expect(h.calls.tailor).toEqual([])
    expect(h.calls.prepare).toEqual([`role/co/${j.id}`])
  })

  it('switching workspaces while a tailoring wait hangs ends the old run at once', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.tailorResults.set(j.id, () => new Promise(() => undefined))
    await h.automation.runNow()
    await until(() => h.state().candidates[j.id]?.step === 'tailoring', 'tailoring')
    h.flags.workspace = '/other'
    const state = await Promise.race([h.automation.getState(), new Promise<null>((r) => setTimeout(() => r(null), 1000))])
    expect(state).not.toBeNull()
    expect(h.calls.stop).toEqual(['stop'])
  })

  it('a step that throws (scoring, writing the prepared file) needs you at that step, once', async () => {
    const j = job()
    const h = harness({ jobs: [j], settings: { sources: { jobs: true, explore: false } } })
    h.deps.score = async () => {
      throw new Error('The master profile could not be read.')
    }
    await h.automation.runNow()
    await idle(h)
    expect(h.state().candidates[j.id]).toMatchObject({ step: 'needs-you', failedStep: 'scoring', error: expect.stringMatching(/profile could not be read/) })
    expect(h.log.filter((e) => e.outcome === 'fail')).toHaveLength(1)

    const k = job()
    const h2 = harness({ jobs: [k], settings: { sources: { jobs: true, explore: false } } })
    h2.deps.writePrepared = async () => {
      throw new Error('ENOSPC')
    }
    await h2.automation.runNow()
    await idle(h2)
    expect(h2.state().candidates[k.id]).toMatchObject({ step: 'needs-you', failedStep: 'filling', error: expect.stringMatching(/ENOSPC/) })
    await h2.automation.runNow()
    await idle(h2)
    expect(h2.calls.prepare).toHaveLength(1)
  })

  it('Retry of a job the run already passed gets its attempt after the current one', async () => {
    const a = job()
    const b = job()
    const h = harness({ jobs: [a, b], settings: { sources: { jobs: true, explore: false } } })
    h.prepareResults.set(`role/co/${a.id}`, { ok: false, status: 'blocked', message: 'Bot check' })
    let finish: (r: TailorResult) => void = () => undefined
    h.tailorResults.set(b.id, () => new Promise((resolve) => (finish = resolve)))
    await h.automation.runNow()
    await until(() => h.state().candidates[a.id]?.step === 'needs-you' && h.state().candidates[b.id]?.step === 'tailoring', 'a failed, b tailoring')
    h.prepareResults.delete(`role/co/${a.id}`)
    await h.automation.retry(a.id)
    finish({ status: 'done', outcome: 'unreviewed', applicationId: `role/co/${b.id}`, runId: 'r' })
    await idle(h)
    expect(h.state().candidates[a.id].step).toBe('ready')
    expect(h.calls.prepare.filter((x) => x === `role/co/${a.id}`)).toHaveLength(2)
  })

  it('the run window switch and today’s count come from userData, not the workspace file', async () => {
    const forged: AutomationState = structuredClone(EMPTY_AUTOMATION_STATE)
    forged.enabled = true
    forged.day = { date: '2026-10-24', started: 0 }
    const h = harness({ initial: forged })
    h.trusted.set('/ws', { enabled: false, day: { date: '2026-10-24', started: 10 } })
    const state = await h.automation.getState()
    expect(state.enabled).toBe(false)
    expect(state.day).toEqual({ date: '2026-10-24', started: 10 })
    // Nothing stored yet (a deleted or new file) is off, never a fresh allowance from the workspace.
    const h2 = harness({ initial: forged })
    expect((await h2.automation.getState()).enabled).toBe(false)
  })
})
