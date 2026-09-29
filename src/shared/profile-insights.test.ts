import { describe, expect, it } from 'vitest'
import { emptyExperience, emptyProfile, emptyProject, type MasterProfile } from './master-profile'
import { applyEvidence, computeGaps, emptySections, unsupportedNumbers, type SourcedJobText } from './profile-insights'

function profile(): MasterProfile {
  const p = emptyProfile()
  p.contact.name = 'Jordan Rivera'
  p.skills = [{ category: 'Languages', items: ['Python', 'Go'] }]
  p.experience = [
    { ...emptyExperience(), company: 'Orbital', role: 'Engineer', start: '2022', end: 'Present', technologies: 'Python, PostgreSQL', highlights: ['Built ETL jobs in Python.'] }
  ]
  p.projects = [{ ...emptyProject(), name: 'Tracegrep', technologies: 'Go', highlights: [] }]
  return p
}

const jobs: SourcedJobText[] = [
  { id: 'eng/acme/1', title: 'Backend at Acme', text: 'We use Python, Kafka and Kubernetes.', kind: 'application' },
  { id: 'hiring.cafe:2', title: 'Data at Globex', text: 'Kafka streaming, Terraform, Go.', kind: 'saved' },
  { id: 'indeed:3', title: 'Platform at Initech', text: 'Kubernetes, Kafka, Python.', kind: 'saved' }
]

describe('computeGaps', () => {
  it('ranks skills jobs ask for that the profile lacks, with the jobs asking', () => {
    const { gaps } = computeGaps(profile(), jobs, new Set())
    expect(gaps.map((g) => [g.skill, g.jobs.length])).toEqual([
      ['Kafka', 3],
      ['Kubernetes', 2],
      ['Terraform', 1]
    ])
    expect(gaps[0].jobs.map((j) => j.kind)).toEqual(['application', 'saved', 'saved'])
    expect(gaps[0].jobs[1].title).toBe('Data at Globex')
  })

  it('leaves out dismissed gaps and those the profile already notes', () => {
    const p = profile()
    p.gaps = ['No production Terraform experience.']
    const { gaps, noted } = computeGaps(p, jobs, new Set(['kafka']))
    expect(gaps.map((g) => g.skill)).toEqual(['Kubernetes'])
    expect(noted).toEqual(['Terraform'])
  })

  it('has no gaps without job descriptions', () => {
    expect(computeGaps(profile(), [], new Set()).gaps).toEqual([])
  })
})

describe('applyEvidence', () => {
  it('adds a highlight and the technology to an experience', () => {
    const next = applyEvidence(profile(), {
      skill: 'Kafka',
      target: { kind: 'experience', index: 0 },
      bullet: 'Moved order events from cron polling to Kafka topics.',
      addTechnology: true
    })
    expect(next.experience[0].technologies).toBe('Python, PostgreSQL, Kafka')
    expect(next.experience[0].highlights).toEqual(['Built ETL jobs in Python.', 'Moved order events from cron polling to Kafka topics.'])
  })

  it('does not duplicate a technology written another way', () => {
    const p = profile()
    p.projects[0].technologies = 'Go, k8s'
    const next = applyEvidence(p, { skill: 'Kubernetes', target: { kind: 'project', index: 0 }, addTechnology: true })
    expect(next.projects[0].technologies).toBe('Go, k8s')
  })

  it('adds the skill to a group, creating it when missing', () => {
    const toExisting = applyEvidence(profile(), { skill: 'Rust', target: { kind: 'skills', category: 'languages' }, addTechnology: true })
    expect(toExisting.skills).toEqual([{ category: 'Languages', items: ['Python', 'Go', 'Rust'] }])
    const toNew = applyEvidence(profile(), { skill: 'Kafka', target: { kind: 'skills', category: 'Streaming' }, addTechnology: true })
    expect(toNew.skills[1]).toEqual({ category: 'Streaming', items: ['Kafka'] })
  })

  it('refuses a missing target or an empty change, and leaves the input untouched', () => {
    const p = profile()
    expect(() => applyEvidence(p, { skill: 'Kafka', target: { kind: 'experience', index: 5 }, addTechnology: true })).toThrow(/no longer/)
    expect(() => applyEvidence(p, { skill: 'Kafka', target: { kind: 'experience', index: 0 }, addTechnology: false })).toThrow(/highlight/)
    applyEvidence(p, { skill: 'Kafka', target: { kind: 'experience', index: 0 }, bullet: 'x', addTechnology: true })
    expect(p.experience[0].technologies).toBe('Python, PostgreSQL')
  })
})

describe('helpers', () => {
  it('lists empty sections', () => {
    expect(emptySections(emptyProfile())).toEqual(['contact', 'summary', 'experience', 'projects', 'education'])
    expect(emptySections(profile())).toEqual(['education'])
  })

  it('flags numbers the notes do not contain', () => {
    const notes = 'Moved about 12 cron jobs to Kafka, cut delay to 2.5 s'
    expect(unsupportedNumbers('Moved 12 cron jobs to Kafka, cutting lag 40% to 2.5 s', notes)).toEqual(['40'])
    expect(unsupportedNumbers('Handled 1,200 events/s', 'about 1200 events per second')).toEqual([])
  })
})
