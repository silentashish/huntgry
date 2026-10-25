import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GATE_CAP, matchScore, type MatchJob, type MatchProfile } from './match-score'
import { resumeCoverage, resumeEvidenceFromData, resumeEvidenceFromText, type ResumeEvidence } from './resume-coverage'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

/** The fixture job (`tailored-job.md`) and resume (`tailored-resume_data.json`, the skill's `ResumeData` shape). */
const job: MatchJob = { title: 'Backend Engineer', description: fixture('tailored-job.md') }
const resume = resumeEvidenceFromData(JSON.parse(fixture('tailored-resume_data.json'))) as ResumeEvidence

const profile = (over: Partial<MatchProfile> = {}): MatchProfile => ({
  skills: ['Python', 'Go', 'PostgreSQL', 'AWS', 'Docker', 'Kubernetes', 'Terraform'],
  years: 4,
  needsSponsorship: false,
  degrees: [{ degree: 'Bachelor of Science', field: 'Computer Science' }],
  evidence: '',
  ...over
})

const names = (xs: { skill: string }[]) => xs.map((x) => x.skill)

describe('resumeEvidenceFromData', () => {
  it("reads the skills rows' names and the resume's words, not its contact details", () => {
    expect(resume.skills).toEqual(['Python', 'Go', 'SQL', 'AWS', 'Docker'])
    expect(resume.text).toContain('Moved the shipment ledger to PostgreSQL')
    expect(resume.text).toContain('Infrastructure: AWS (EC2, S3), Docker')
    expect(resume.text).toContain('B.S. in Computer Science')
    expect(resume.text).not.toContain('sam@example.com')
  })

  it('also reads skills rows written as a list under a category', () => {
    const r = resumeEvidenceFromData({ skills: [{ category: 'Languages', items: ['Go', 'TypeScript', 3] }] })
    expect(r).toEqual({ skills: ['Go', 'TypeScript'], text: 'Languages: Go, TypeScript' })
  })

  it('is null for anything that is not a resume payload', () => {
    expect(resumeEvidenceFromData(null)).toBeNull()
    expect(resumeEvidenceFromData([])).toBeNull()
    expect(resumeEvidenceFromData('text')).toBeNull()
    expect(resumeEvidenceFromData({ contact: { name: 'x' } })).toBeNull()
  })

  it('skips malformed fields instead of throwing', () => {
    const r = resumeEvidenceFromData({ skills: [{ items: 42 }, null, { label: 'Tools', items: 'Kafka' }], experience: 'x', summary: 7 })
    expect(r).toEqual({ skills: ['Kafka'], text: 'Tools: Kafka' })
  })
})

describe('resumeCoverage', () => {
  it('scores the fixture: profile fit, resume coverage, surfaced and what the resume left out', () => {
    const r = resumeCoverage(job, profile(), resume)
    // Required: Python, Go, PostgreSQL, AWS, Kafka, Docker, Kubernetes (1 each); Terraform is a plus (0.5).
    expect(r).toMatchObject({
      profileFit: Math.round((6.5 / 7.5) * 100),
      resumeCoverage: Math.round((5 / 7.5) * 100),
      surfaced: Math.round((5 / 6.5) * 100),
      requirements: 8,
      unbacked: [],
      gates: [],
      source: 'description'
    })
    expect(names(r!.leftOut)).toEqual(['Kubernetes', 'Terraform'])
    expect(names(r!.missing)).toEqual(['Kafka'])
    expect(names(r!.shown)).toEqual(['AWS', 'Docker', 'Go', 'PostgreSQL', 'Python'])
  })

  it('uses the same requirements and profile fit as matchScore', () => {
    const fit = matchScore(job, profile())
    const r = resumeCoverage(job, profile(), resume)!
    expect(r.profileFit).toBe(fit.score)
    expect(r.requirements).toBe(fit.matched.length + fit.missing.length)
  })

  it('is 100% surfaced when the resume shows everything the profile has', () => {
    const r = resumeCoverage(job, profile({ skills: ['Python', 'Go', 'PostgreSQL', 'AWS', 'Docker'] }), resume)!
    expect(r.surfaced).toBe(100)
    expect(r.resumeCoverage).toBe(r.profileFit)
    expect(r.leftOut).toEqual([])
  })

  it('never reports more than 100% surfaced, even when the resume shows what the profile lacks', () => {
    // The profile has only Python; the resume names more (a synonym the profile missed, or a claim to check).
    const r = resumeCoverage(job, profile({ skills: ['Python'] }), resume)!
    expect(r.surfaced).toBe(100)
    expect(r.resumeCoverage).toBeGreaterThan(r.profileFit)
    expect(names(r.unbacked)).toEqual(['AWS', 'Docker', 'Go', 'PostgreSQL'])
  })

  it('has no surfaced share when the profile matches nothing, and no division by zero', () => {
    const r = resumeCoverage(job, profile({ skills: [] }), { skills: [], text: 'Customer support lead.' })!
    expect(r).toMatchObject({ profileFit: 0, resumeCoverage: 0, surfaced: null })
  })

  it('is null when the job names no requirement', () => {
    expect(resumeCoverage({ title: 'Office Manager', description: 'Run the front desk.' }, profile(), resume)).toBeNull()
  })

  it('caps both numbers at GATE_CAP when a must-have fails', () => {
    const r = resumeCoverage(job, profile({ years: 1 }), resume)!
    expect(r.gates.map((g) => g.kind)).toEqual(['years'])
    expect(r.profileFit).toBe(GATE_CAP)
    expect(r.resumeCoverage).toBe(GATE_CAP)
    // Surfaced compares weights, so the cap does not hide what the resume left out.
    expect(r.surfaced).toBe(Math.round((5 / 6.5) * 100))
  })

  it('weighs Jobright skills the same way for both numbers', () => {
    const jobright: MatchJob = {
      title: 'Backend Engineer',
      description: '',
      jdCoreSkills: [
        { skill: 'Python Programming', score: 3, type: 'hard_skill' },
        { skill: 'Kubernetes', score: 1, type: 'hard_skill' },
        { skill: 'Communication', score: 3, type: 'soft_skill' }
      ]
    }
    const r = resumeCoverage(jobright, profile({ evidence: 'Explained designs to customers; strong communication.' }), resume)!
    expect(r.source).toBe('jobright-skills')
    // Profile: 3 + 1 + 0.9 of 4.9; resume: Python only.
    expect(r).toMatchObject({ profileFit: 100, resumeCoverage: Math.round((3 / 4.9) * 100), surfaced: Math.round((3 / 4.9) * 100) })
    expect(names(r.leftOut)).toEqual(['Kubernetes', 'Communication'])
  })

  it('reads a resume known only by its PDF text', () => {
    const text = resumeEvidenceFromText('Software Engineer\nBuilt services in Python and Go on AWS with PostgreSQL and Docker.')!
    const r = resumeCoverage(job, profile(), text)!
    expect(names(r.shown)).toEqual(['AWS', 'Docker', 'Go', 'PostgreSQL', 'Python'])
    expect(resumeEvidenceFromText('  ')).toBeNull()
  })
})
