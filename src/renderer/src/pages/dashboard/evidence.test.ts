import { describe, expect, it } from 'vitest'
import { emptyExperience, emptyProfile, type MasterProfile } from '@shared/master-profile'
import { applyEvidence } from '@shared/profile-insights'
import { changeLines } from './evidence'

function profile(): MasterProfile {
  const p = emptyProfile()
  p.experience = [{ ...emptyExperience(), role: 'Senior Backend Engineer', company: 'Acme', technologies: 'Go, PostgreSQL', highlights: ['Built billing.'] }]
  p.skills = [{ category: 'Languages', items: ['Go', 'Python'] }]
  return p
}

describe('changeLines', () => {
  it('shows the technologies line it replaces as removed and the added lines', () => {
    const before = profile()
    const target = { kind: 'experience', index: 0 } as const
    const after = applyEvidence(before, { skill: 'Kafka', target, bullet: 'Moved billing events onto Kafka.', addTechnology: true })
    expect(changeLines(before, after, target)).toEqual({
      removed: ['Technologies: Go, PostgreSQL'],
      added: ['Technologies: Go, PostgreSQL, Kafka', '- Moved billing events onto Kafka.']
    })
  })

  it('adds to an existing skill group, or starts a new one without removing anything', () => {
    const before = profile()
    const existing = { kind: 'skills', category: 'Languages' } as const
    expect(changeLines(before, applyEvidence(before, { skill: 'Rust', target: existing, addTechnology: true }), existing)).toEqual({
      removed: ['Skills · Languages: Go, Python'],
      added: ['Skills · Languages: Go, Python, Rust']
    })
    const fresh = { kind: 'skills', category: 'Data' } as const
    expect(changeLines(before, applyEvidence(before, { skill: 'Airflow', target: fresh, addTechnology: true }), fresh)).toEqual({
      removed: [],
      added: ['Skills · Data: Airflow']
    })
  })
})
