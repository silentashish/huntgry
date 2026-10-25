import { describe, expect, it } from 'vitest'
import type { ApplicationMatch } from '@shared/applications-types'
import { matchText } from './match-text'

const match: ApplicationMatch = {
  profileFit: 82,
  resumeCoverage: 74,
  surfaced: 90,
  requirements: 11,
  leftOut: ['Kubernetes', 'Terraform'],
  resumeFrom: 'resume_data.json',
  source: 'description',
  at: '2026-10-24T12:00:00.000Z'
}

describe('matchText (#151)', () => {
  it('reads "Profile fit 82 · Resume 74 (90% surfaced)" and lists what was left out', () => {
    const t = matchText(match)
    expect(t.line).toBe('Profile fit 82 · Resume 74 (90% surfaced)')
    expect(t.leftOut).toBe('Left out: Kubernetes, Terraform')
    expect(t.title).toContain("the job's 11 requirements")
  })

  it('leaves the surfaced share out when the profile matched nothing', () => {
    const t = matchText({ ...match, profileFit: 0, resumeCoverage: 0, surfaced: undefined, leftOut: [] })
    expect(t.line).toBe('Profile fit 0 · Resume 0')
    expect(t.leftOut).toBeNull()
    expect(t.title).not.toContain('Surfaced')
  })

  it('says a failed must-have caps both numbers', () => {
    expect(matchText({ ...match, gates: ['Asks for 8+ years of experience (you have 4)'] }).title).toContain(
      'Asks for 8+ years of experience (you have 4): both scores are capped.'
    )
  })
})
