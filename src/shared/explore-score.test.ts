import { describe, expect, it } from 'vitest'
import { hasQualifications, scoreRow, scoreRows, toJob } from './explore-score'
import type { ExploreJob } from './explore-types'
import { profileSignals, scoreJob, titleEstimate } from './job-relevance'
import { emptyExperience, emptyProfile } from './master-profile'
import { matchScore } from './match-score'

const NOW = new Date('2026-10-25T12:00:00Z')

const signals = (() => {
  const p = emptyProfile()
  p.contact.headline = 'Backend Engineer'
  p.contact.location = 'Portland, OR'
  p.skills = [{ category: 'Languages', items: ['Go', 'Python', 'PostgreSQL', 'AWS'] }]
  p.experience = [{ ...emptyExperience(), role: 'Software Engineer', start: 'Jan 2024', end: 'Present', technologies: 'Go' }]
  p.education = [{ institution: 'State', degree: 'Bachelor of Science', field: 'Computer Science', start: '', end: '', location: '', gpa: '', highlights: [] }]
  return profileSignals(p, NOW)
})()

const row = (over: Partial<ExploreJob> = {}): ExploreJob => ({
  id: 'abcdef123456',
  company: 'Northwind',
  companyUrl: null,
  title: 'Backend Engineer I',
  url: 'https://jobright.ai/jobs/info/abcdef123456',
  location: 'Seattle, WA',
  workModel: 'Remote',
  postedAt: '2026-10-24',
  ...over
})

describe('scoreRow (#150)', () => {
  it('scores an API row exactly from its qualifications with the match score', () => {
    const r = row({ qualifications: '1. Go and Python services.\n2. Experience with Kafka.\n3. Java is a plus.' })
    const s = scoreRow(r, signals, NOW)
    const expected = matchScore({ title: r.title, description: r.qualifications! }, signals)
    expect(s).toEqual({ kind: 'exact', score: expected.score, matched: expected.matched, missing: expected.missing, gates: expected.gates })
    expect(s.kind === 'exact' && s.matched.map((m) => m.skill)).toEqual(['Go', 'Python'])
    expect(s.kind === 'exact' && s.missing.map((m) => m.skill)).toEqual(['Kafka', 'Java'])
    expect(s.score).toBe(57)
  })

  it('reports a failed gate from the qualifications, capped like the match score', () => {
    const s = scoreRow(row({ qualifications: '1. Go and Python.\n2. 8+ years of professional experience.' }), signals, NOW)
    expect(s.kind).toBe('exact')
    expect(s.kind === 'exact' && s.gates.map((g) => g.kind)).toEqual(['years'])
    expect(s.score).toBeLessThanOrEqual(40)
  })

  it('never estimates a row with qualifications, even one that names no skill', () => {
    const s = scoreRow(row({ qualifications: '1. Strong communication.' }), signals, NOW)
    expect(s).toMatchObject({ kind: 'exact', score: 0, matched: [], missing: [] })
  })

  it('gives a README row (no qualifications) the title-only estimate', () => {
    for (const r of [row(), row({ qualifications: '   ' })]) {
      const s = scoreRow(r, signals, NOW)
      expect(s).toEqual({ kind: 'estimate', ...titleEstimate(toJob(r, NOW), signals) })
      expect(s.kind === 'estimate' && s.reasons).toEqual(['Title: Backend Engineer', 'Remote'])
    }
    // A title in common scores above one with none.
    const other = scoreRow(row({ title: 'Registered Nurse', workModel: 'On Site' }), signals, NOW)
    expect(other.kind === 'estimate' && other.reasons[0]).toBe('No target title in common')
    expect(other.score).toBeLessThan(scoreRow(row(), signals, NOW).score)
  })

  it('is deterministic and does not depend on the day it runs', () => {
    const r = row({ qualifications: '1. Go.' })
    expect(scoreRow(r, signals, NOW)).toEqual(scoreRow(r, signals, new Date('2027-01-01T00:00:00Z')))
  })

  it('scores the same as the job the row is saved as (Jobs and Automation read that job)', () => {
    const r = row({ qualifications: '1. Go and AWS.\n2. PostgreSQL and Rust.' })
    const job = toJob(r, NOW)
    expect(job.description).toBe(r.qualifications)
    expect(job.descriptionComplete).toBe(false)
    expect(scoreJob(job, signals, NOW).match.score).toBe(scoreRow(r, signals, NOW).score)
  })

  it('scoreRows keys every row by id', () => {
    const rows = [row({ id: 'aaaaaa111111', qualifications: '1. Go.' }), row({ id: 'bbbbbb222222' })]
    const m = scoreRows(rows, signals, NOW)
    expect([...m.keys()]).toEqual(['aaaaaa111111', 'bbbbbb222222'])
    expect(m.get('aaaaaa111111')?.kind).toBe('exact')
    expect(m.get('bbbbbb222222')?.kind).toBe('estimate')
  })

  it('hasQualifications ignores blank text', () => {
    expect(hasQualifications({ qualifications: '1. Go.' })).toBe(true)
    expect(hasQualifications({ qualifications: ' \n ' })).toBe(false)
    expect(hasQualifications({})).toBe(false)
  })

  it('scores a full list of API rows quickly enough to do once per open', () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      row({ id: `r${String(i).padStart(11, '0')}`, qualifications: `1. A degree in computer science.\n2. Experience with Go, Kubernetes and React ${i}.\n3. 2+ years of experience.` })
    )
    const t = performance.now()
    scoreRows(rows, signals, NOW)
    // A generous bound (it takes well under 0.1 ms a row): nothing per row is slow, nothing is loaded.
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
