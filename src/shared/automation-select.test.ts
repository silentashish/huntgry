import { describe, expect, it } from 'vitest'
import type { ApplicationRecord } from './applications-types'
import { localDay, matchSkipReason, selectCandidates, type CandidateInput, type SelectContext } from './automation-select'
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationCandidate } from './automation-types'
import { DEFAULT_FILTERS } from './job-filters'
import { profileSignals } from './job-relevance'
import type { Job } from './jobs-types'
import { emptyExperience, emptyProfile, type MasterProfile } from './master-profile'

const NOW = new Date('2026-10-20T12:00:00Z')

function backend(): MasterProfile {
  const p = emptyProfile()
  p.contact.headline = 'Backend Engineer | Payments'
  p.contact.location = 'Portland, OR'
  p.skills = [{ category: 'Languages', items: ['Go', 'Python', 'TypeScript', 'PostgreSQL', 'AWS'] }]
  p.experience = [
    { ...emptyExperience(), role: 'Software Engineer', start: 'Jun 2018', end: 'Dec 2021', technologies: 'Python, Django' },
    { ...emptyExperience(), role: 'Senior Backend Engineer', start: 'Jan 2022', end: 'Present', technologies: 'Go, AWS' }
  ]
  return p
}

const SIGNALS = profileSignals(backend(), NOW)

let n = 0
const job = (over: Partial<Job>): Job => ({
  id: `pasted:j${++n}`,
  source: 'pasted',
  sourceId: `j${n}`,
  title: 'Backend Engineer',
  company: `Company ${n}`,
  location: 'Remote',
  remote: true,
  salary: '',
  postedAt: '2026-10-18T00:00:00Z',
  url: `https://example.com/jobs/${n}`,
  boardUrl: null,
  description: '',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-18T00:00:00Z',
  ...over
})

/** Five requirements, all on the profile: Match 100. */
const ALL = 'We use Go, Python, TypeScript, PostgreSQL and AWS every day.'
/** Four of five on the profile: Match 80. */
const FOUR_OF_FIVE = 'We use Go, Python, PostgreSQL, AWS and Kubernetes every day.'
/** Three of four: Match 75. */
const THREE_OF_FOUR = 'We use Go, Python, AWS and Kubernetes every day.'

const input = (j: Job, over: Partial<CandidateInput> = {}): CandidateInput => ({
  key: j.id,
  source: 'jobs',
  job: j,
  savedJobId: j.id,
  scoreable: j.description.trim().length > 0,
  ...over
})

const app = (over: Partial<ApplicationRecord> & { status?: ApplicationRecord['tracking']['status'] }): SelectContext['applications'][number] => ({
  id: over.id ?? 'backend-engineer/acme/x',
  jobId: over.jobId ?? 'x',
  company: over.company ?? 'Acme',
  createdAt: over.createdAt ?? '2026-10-15T00:00:00Z',
  jobUrl: over.jobUrl ?? null,
  tracking: { status: over.status ?? 'generated', notes: '' }
})

function ctx(over: Partial<SelectContext> = {}): SelectContext {
  return {
    signals: SIGNALS,
    filters: DEFAULT_FILTERS,
    applications: [],
    candidates: {},
    day: { date: localDay(NOW), started: 0 },
    settings: DEFAULT_AUTOMATION_SETTINGS,
    now: NOW,
    today: localDay(NOW),
    ...over
  }
}

const candidate = (over: Partial<AutomationCandidate>): AutomationCandidate => ({
  key: 'k',
  source: 'jobs',
  title: 'Backend Engineer',
  company: 'Acme',
  reasons: [],
  step: 'ready',
  updatedAt: NOW.toISOString(),
  ...over
})

const keys = (cs: AutomationCandidate[]) => cs.map((c) => c.key)
const reasonOf = (cs: AutomationCandidate[], key: string) => cs.find((c) => c.key === key)?.reasons[0]

describe('selectCandidates: the match rules', () => {
  it('picks a job at the threshold (80) with 5 requirements, and skips one below it', () => {
    const at = job({ description: FOUR_OF_FIVE })
    const below = job({ description: THREE_OF_FOUR })
    const { picked, skipped } = selectCandidates([input(at), input(below)], ctx())
    expect(picked.map((c) => [c.key, c.match?.score, c.match?.requirements])).toEqual([[at.id, 80, 5]])
    expect(picked[0].reasons[0]).toBe('Match 80 · 5 requirements')
    expect(picked[0].step).toBe('selected')
    // Three of four: 4 requirements (the minimum) but below the threshold.
    expect(reasonOf(skipped, below.id)).toBe('Match 75, below 80.')
  })

  it('needs at least minRequirements requirements (a job naming 3 skills scores 100 but is thin)', () => {
    const thin = job({ description: 'Go, Python and AWS.' })
    const { picked, skipped } = selectCandidates([input(thin)], ctx())
    expect(picked).toEqual([])
    expect(reasonOf(skipped, thin.id)).toBe('Names only 3 requirements (fewer than 4).')
    // Lowering the minimum lets it through.
    expect(keys(selectCandidates([input(thin)], ctx({ settings: { ...DEFAULT_AUTOMATION_SETTINGS, minRequirements: 3 } })).picked)).toEqual([thin.id])
  })

  it('skips a job whose posting names no requirements as unknown, not as a mismatch', () => {
    const vague = job({ description: 'A friendly team building great things together.' })
    const { skipped } = selectCandidates([input(vague)], ctx())
    expect(reasonOf(skipped, vague.id)).toBe('Match unknown: the posting names no requirements Huntgry can read.')
  })

  it('skips a job with a failed must-have gate, with the gate as the reason', () => {
    const cleared = job({ description: `${ALL} An active Top Secret clearance is required.` })
    const { picked, skipped } = selectCandidates([input(cleared)], ctx())
    expect(picked).toEqual([])
    expect(reasonOf(skipped, cleared.id)).toMatch(/clearance/i)
    expect(skipped[0].match?.gates.length).toBeGreaterThan(0)
  })

  it('keeps Relevant exclusions: dismissed, no sponsorship for someone who needs it, nothing in common', () => {
    const dismissed = job({ description: ALL, dismissed: true })
    const noVisa = job({ description: `${ALL} We are unable to sponsor visas.` })
    const unrelated = job({ title: 'Pastry Chef', description: 'Croissants, laminated dough, early mornings.' })
    const needsVisa = { ...SIGNALS, needsSponsorship: true }
    const { picked, skipped } = selectCandidates([input(dismissed), input(noVisa), input(unrelated)], ctx({ signals: needsVisa }))
    expect(picked).toEqual([])
    expect(reasonOf(skipped, dismissed.id)).toBe('Dismissed.')
    expect(reasonOf(skipped, noVisa.id)).toBe('Says it does not sponsor visas.')
    expect(reasonOf(skipped, unrelated.id)).toBe('No title or skill in common with your profile.')
  })

  it("applies the user's saved Jobs filters (workplace, seniority, salary)", () => {
    const onsite = job({ description: ALL, remote: false, workplaceType: 'Onsite', location: 'Austin, TX' })
    const { picked, skipped } = selectCandidates([input(onsite)], ctx({ filters: { ...DEFAULT_FILTERS, workplace: ['Remote'] } }))
    expect(picked).toEqual([])
    expect(reasonOf(skipped, onsite.id)).toBe('Hidden by your Jobs filters.')
  })

  it('skips jobs already applied to or tailored, matched like the Board (URL, or job id with the company)', () => {
    const applied = job({ description: ALL })
    const tailored = job({ description: ALL, company: 'Tyrell Robotics' })
    const flagged = job({ description: ALL, tailoredAt: '2026-10-01T00:00:00Z' })
    const applications = [
      app({ id: 'a/b/1', jobUrl: applied.url, company: applied.company, status: 'applied' }),
      app({ id: 'a/b/2', jobId: tailored.sourceId, company: 'tyrell-robotics', status: 'generated' })
    ]
    const { picked, skipped } = selectCandidates([input(applied), input(tailored), input(flagged)], ctx({ applications }))
    expect(picked).toEqual([])
    expect(reasonOf(skipped, applied.id)).toBe('Already applied.')
    expect(reasonOf(skipped, tailored.id)).toBe('Tailored before.')
    expect(reasonOf(skipped, flagged.id)).toBe('Tailored before.')
  })

  it('leaves out jobs Automation settled, is working on, or skipped for good on their full posting', () => {
    const ready = job({ description: ALL })
    const needsYou = job({ description: ALL })
    const working = job({ description: ALL })
    const final = job({ description: ALL })
    const submitted = job({ description: ALL })
    const retryable = job({ description: ALL })
    const candidates = {
      [ready.id]: candidate({ key: ready.id, step: 'ready', company: ready.company }),
      [needsYou.id]: candidate({ key: needsYou.id, step: 'needs-you', company: needsYou.company }),
      [working.id]: candidate({ key: working.id, step: 'tailoring', company: working.company }),
      [final.id]: candidate({ key: final.id, step: 'skipped', final: true, company: final.company }),
      [submitted.id]: candidate({ key: submitted.id, step: 'submitted', company: submitted.company }),
      // A cap skip is not final: tomorrow it is picked again.
      [retryable.id]: candidate({ key: retryable.id, step: 'skipped', company: retryable.company, reasons: ['Cap: 10 a day.'] })
    }
    const { picked, skipped } = selectCandidates([ready, needsYou, working, final, submitted, retryable].map((j) => input(j)), ctx({ candidates }))
    expect(keys(picked)).toEqual([retryable.id])
    expect(skipped).toEqual([])
  })

  it('finds the record of an Explore row saved since under its saved job id', () => {
    const saved = job({ id: 'jobright:abc123', source: 'jobright', sourceId: 'abc123', description: ALL })
    const candidates = { [saved.id]: candidate({ key: saved.id, step: 'needs-you', company: saved.company }) }
    const row = input(saved, { key: 'explore:abc123', source: 'explore' })
    expect(selectCandidates([row], ctx({ candidates })).picked).toEqual([])
  })

  it('orders scored jobs by match, then newest; Explore rows without a description come after, by Relevant score', () => {
    const older80 = job({ description: FOUR_OF_FIVE, postedAt: '2026-10-10T00:00:00Z' })
    const newer80 = job({ description: FOUR_OF_FIVE, postedAt: '2026-10-19T00:00:00Z' })
    const best = job({ description: ALL, postedAt: '2026-10-01T00:00:00Z' })
    const row = job({ id: 'jobright:row1', source: 'jobright', sourceId: 'row1', description: '', descriptionComplete: false })
    const { picked } = selectCandidates([input(row, { key: 'explore:row1', source: 'explore', savedJobId: undefined }), input(older80), input(newer80), input(best)], ctx())
    expect(keys(picked)).toEqual([best.id, newer80.id, older80.id, 'explore:row1'])
    expect(picked[3].match).toBeUndefined()
    expect(picked[3].reasons[0]).toBe('Scored once its posting is read.')
  })

  it('counts a job once across sources: the saved job wins over its Explore row', () => {
    const saved = job({ id: 'jobright:dup1', source: 'jobright', sourceId: 'dup1', description: ALL })
    const fromJobs = input(saved)
    const fromExplore = input(saved, { key: saved.id, source: 'explore' })
    const sameTitle = input(job({ title: saved.title, company: saved.company, description: ALL }))
    const { picked } = selectCandidates([fromJobs, fromExplore, sameTitle], ctx())
    expect(picked.map((c) => [c.key, c.source])).toEqual([[saved.id, 'jobs']])
  })
})

describe('selectCandidates: the caps', () => {
  it('per company: at most 2, counting ready, in-flight and applications of the last 30 days', () => {
    const settings = { ...DEFAULT_AUTOMATION_SETTINGS, perCompany: 2 }
    const a = job({ description: ALL, company: 'Initech' })
    const b = job({ description: ALL, company: 'Initech', title: 'Platform Engineer' })
    const c = job({ description: ALL, company: 'INITECH', title: 'Backend Engineer II' })
    const { picked, skipped } = selectCandidates([input(a), input(b), input(c)], ctx({ settings }))
    expect(keys(picked)).toEqual([a.id, b.id])
    expect(reasonOf(skipped, c.id)).toBe('Cap: 2 per company.')

    // One application created 10 days ago and one ready job hold both places; one from 40 days ago does not count.
    const applications = [
      app({ id: 'x/initech/1', company: 'Initech', createdAt: '2026-10-10T00:00:00Z' }),
      app({ id: 'x/initech/2', company: 'Initech', createdAt: '2026-09-01T00:00:00Z' })
    ]
    const ready = { r: candidate({ key: 'r', step: 'ready', company: 'initech', applicationId: 'y/initech/3' }) }
    const held = selectCandidates([input(a)], ctx({ settings, applications, candidates: ready }))
    expect(held.picked).toEqual([])
    expect(reasonOf(held.skipped, a.id)).toBe('Cap: 2 per company.')
    // A ready job is not counted twice when its application is listed too.
    const same = selectCandidates([input(a)], ctx({ settings, applications: [app({ id: 'y/initech/3', company: 'Initech' })], candidates: ready }))
    expect(keys(same.picked)).toEqual([a.id])
  })

  it('per company: an automated submission older than 30 days no longer holds a place', () => {
    const settings = { ...DEFAULT_AUTOMATION_SETTINGS, perCompany: 2 }
    const fresh = job({ description: ALL, company: 'Hooli' })
    const old = (k: string, at: string) => candidate({ key: k, step: 'submitted', company: 'Hooli', applicationId: `x/hooli/${k}`, updatedAt: at })
    const aged = { s1: old('s1', '2026-09-01T00:00:00Z'), s2: old('s2', '2026-09-02T00:00:00Z') }
    expect(keys(selectCandidates([input(fresh)], ctx({ settings, candidates: aged })).picked)).toEqual([fresh.id])
    const recent = { s1: old('s1', '2026-10-10T00:00:00Z'), s2: old('s2', '2026-10-11T00:00:00Z') }
    expect(reasonOf(selectCandidates([input(fresh)], ctx({ settings, candidates: recent })).skipped, fresh.id)).toBe('Cap: 2 per company.')
  })

  it('per day: at most perDay scored jobs, counting jobs started earlier today, reset the next local day', () => {
    const settings = { ...DEFAULT_AUTOMATION_SETTINGS, perDay: 10 }
    const jobs = Array.from({ length: 4 }, () => job({ description: ALL }))
    const today = localDay(NOW)
    const run = selectCandidates(jobs.map((j) => input(j)), ctx({ settings, day: { date: today, started: 8 } }))
    expect(run.picked).toHaveLength(2)
    expect(run.skipped.map((c) => c.reasons[0])).toEqual(['Cap: 10 a day.', 'Cap: 10 a day.'])
    // Yesterday's count does not hold today.
    expect(selectCandidates(jobs.map((j) => input(j)), ctx({ settings, day: { date: '2026-10-19', started: 10 } })).picked).toHaveLength(4)
    // At the cap: nothing.
    expect(selectCandidates(jobs.map((j) => input(j)), ctx({ settings, day: { date: today, started: 10 } })).picked).toHaveLength(0)
  })

  it('does not count Explore rows against the daily cap until they are scored (the service checks it at tailoring)', () => {
    const settings = { ...DEFAULT_AUTOMATION_SETTINGS, perDay: 1 }
    const row = job({ id: 'jobright:r9', source: 'jobright', sourceId: 'r9', description: '', descriptionComplete: false })
    const scored = job({ description: ALL })
    const { picked } = selectCandidates([input(scored), input(row, { key: 'explore:r9', source: 'explore', savedJobId: undefined })], ctx({ settings }))
    expect(keys(picked)).toEqual([scored.id, 'explore:r9'])
  })
})

describe('matchSkipReason', () => {
  const m = (over: Partial<Parameters<typeof matchSkipReason>[0]>) => ({ score: 90, requirements: 5, matched: [], missing: [], gates: [], source: 'description' as const, ...over })
  it('passes at the threshold and the minimum, not one below', () => {
    expect(matchSkipReason(m({ score: 80, requirements: 4 }), DEFAULT_AUTOMATION_SETTINGS)).toBeNull()
    expect(matchSkipReason(m({ score: 79 }), DEFAULT_AUTOMATION_SETTINGS)).toBe('Match 79, below 80.')
    expect(matchSkipReason(m({ requirements: 3 }), DEFAULT_AUTOMATION_SETTINGS)).toBe('Names only 3 requirements (fewer than 4).')
    expect(matchSkipReason(m({ score: 0, requirements: 0 }), DEFAULT_AUTOMATION_SETTINGS)).toMatch(/unknown/)
    expect(matchSkipReason(m({ gates: [{ kind: 'years', reason: 'Asks for 10+ years (you have 8)' }] }), DEFAULT_AUTOMATION_SETTINGS)).toBe('Asks for 10+ years (you have 8)')
  })
})
