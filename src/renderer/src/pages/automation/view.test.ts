import { describe, expect, it } from 'vitest'
import { DEFAULT_AUTOMATION_SETTINGS, EMPTY_AUTOMATION_STATE, type AutomationCandidate, type AutomationState } from '@shared/automation-types'
import type { FillReport } from '@shared/apply-types'
import { aiLines, automationBadge, countersText, firstReason, openRequiredLines, reasonsDetail, relativeTime, sectionsOf, statusPill } from './view'

const cand = (key: string, over: Partial<AutomationCandidate> = {}): AutomationCandidate => ({
  key,
  source: 'explore',
  title: `Engineer ${key}`,
  company: 'Contoso',
  reasons: [],
  step: 'selected',
  updatedAt: '2026-10-24T10:00:00.000Z',
  ...over
})

const stateWith = (over: Partial<AutomationState> = {}, ...cands: AutomationCandidate[]): AutomationState => ({
  ...structuredClone(EMPTY_AUTOMATION_STATE),
  candidates: Object.fromEntries(cands.map((c) => [c.key, c])),
  ...over
})

describe('automation view', () => {
  it('says Off, Waiting for the window, Running with the step, Paused, Waiting and Stopped', () => {
    expect(statusPill(stateWith()).label).toBe('Off')
    expect(statusPill(stateWith({ enabled: true, nextWindowAt: '2026-10-24T22:00:00' })).label).toMatch(/^Waiting for window · opens at /)
    expect(statusPill(stateWith({ enabled: true })).label).toBe('Run window open')
    const run = { id: 'a-1', startedAt: '2026-10-24T10:00:00Z', status: 'running' as const, trigger: 'now' as const, costUsd: 0, pageLoads: 0, candidates: ['j1'], current: 'j1' }
    expect(statusPill(stateWith({ run }, cand('j1', { step: 'tailoring' }))).label).toBe('Running · Tailoring')
    expect(statusPill(stateWith({ run: { ...run, status: 'paused' } })).label).toBe('Paused')
    expect(statusPill(stateWith({ run: { ...run, status: 'waiting', message: 'Waiting for your apply session to end.' } })).label).toBe(
      'Waiting: Waiting for your apply session to end.'
    )
    expect(statusPill(stateWith({ lastRun: { ...run, status: 'stopped-cost' } })).label).toBe('Stopped: cost cap')
  })

  it('badges ready jobs, in warning tone when a job needs you', () => {
    expect(automationBadge(stateWith())).toBeNull()
    expect(automationBadge(stateWith({}, cand('a', { step: 'ready' }), cand('b', { step: 'ready' })))).toEqual({ count: 2, label: '2 ready to submit', tone: 'accent' })
    expect(automationBadge(stateWith({}, cand('a', { step: 'ready' }), cand('b', { step: 'needs-you' })))).toEqual({
      count: 1,
      label: '1 ready to submit, 1 needs you',
      tone: 'warning'
    })
  })

  it('splits Ready to submit, Needs you and the other candidates, working ones first, then by match', () => {
    const s = sectionsOf(
      stateWith(
        {},
        cand('skip', { step: 'skipped', match: { score: 90, requirements: 5, matched: [], missing: [], gates: [], source: 'description' } }),
        cand('sel-low', { match: { score: 81, requirements: 5, matched: [], missing: [], gates: [], source: 'description' } }),
        cand('sel-high', { match: { score: 95, requirements: 5, matched: [], missing: [], gates: [], source: 'description' } }),
        cand('work', { step: 'filling' }),
        cand('ready', { step: 'ready' }),
        cand('needs', { step: 'needs-you' })
      )
    )
    expect(s.ready.map((c) => c.key)).toEqual(['ready'])
    expect(s.needsYou.map((c) => c.key)).toEqual(['needs'])
    expect(s.others.map((c) => c.key)).toEqual(['work', 'sel-high', 'sel-low', 'skip'])
  })

  it('shows the first reason and, on hover, every reason with matched, missing and gates', () => {
    const c = cand('a', {
      reasons: ['Cap: 2 per company.', 'Match 85 · 5 requirements'],
      match: { score: 85, requirements: 5, matched: ['Go', 'AWS'], missing: ['Rust'], gates: [{ kind: 'years', reason: 'Asks for 5+ years' }], source: 'description' }
    })
    expect(firstReason(c)).toBe('Cap: 2 per company.')
    expect(firstReason(cand('b'))).toBe('—')
    expect(reasonsDetail(c).split('\n')).toEqual(['Cap: 2 per company.', 'Match 85 · 5 requirements', 'Matched: Go, AWS', 'Missing: Rust', 'Gate: Asks for 5+ years'])
  })

  it('counts today and the run cost against the caps', () => {
    const now = new Date(2026, 9, 24, 23, 0)
    const s = stateWith({ day: { date: '2026-10-24', started: 4 } })
    expect(countersText(s, DEFAULT_AUTOMATION_SETTINGS, now)).toBe('4 of 10 today · $0.00 of $15.00 this run')
    expect(countersText(stateWith({ day: { date: '2026-10-23', started: 9 } }), DEFAULT_AUTOMATION_SETTINGS, now)).toMatch(/^0 of 10 today/)
  })

  it('lists the AI-written and the open required lines of a prepared report', () => {
    const report: FillReport = {
      ats: 'generic',
      url: 'https://x.example/apply',
      hasSubmitButton: true,
      fields: [
        { key: 'firstName', label: 'First name', kind: 'text', required: true, outcome: 'filled', value: 'Alex' },
        { key: null, label: 'What interests you?', kind: 'textarea', required: false, outcome: 'filled', value: 'Fake draft', suggestedBy: 'draft' },
        { key: null, label: 'Authorized?', kind: 'select', required: true, outcome: 'filled', value: 'Yes', suggestedBy: 'model' },
        { key: null, label: 'Pronouns', kind: 'text', required: true, outcome: 'unmatched' },
        { key: 'resume', label: 'Resume', kind: 'file', required: true, outcome: 'to-upload' }
      ]
    }
    expect(aiLines(report).map((f) => f.label)).toEqual(['What interests you?', 'Authorized?'])
    expect(openRequiredLines(report).map((f) => f.label)).toEqual(['Pronouns'])
  })

  it('says how long ago', () => {
    const now = Date.parse('2026-10-24T12:00:00Z')
    expect(relativeTime('2026-10-24T11:59:30Z', now)).toBe('just now')
    expect(relativeTime('2026-10-24T11:55:00Z', now)).toBe('5 min ago')
    expect(relativeTime('2026-10-24T09:00:00Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-10-22T12:00:00Z', now)).toBe('2 d ago')
  })
})
