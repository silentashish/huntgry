import { describe, expect, it } from 'vitest'
import { emptyExperience, emptyProfile, type MasterProfile } from '@shared/master-profile'
import { countChanges, fieldsLabel, leaveMessage, profileChanges } from './changes'

const base = (): MasterProfile => ({
  ...emptyProfile(),
  contact: { ...emptyProfile().contact, name: 'Alex Rivera', email: 'alex@example.com' },
  summary: 'Backend engineer.',
  skills: [{ category: 'Languages', items: ['Go', 'Python'] }],
  experience: [{ ...emptyExperience(), company: 'Acme', role: 'Engineer', highlights: ['Shipped **things**.'] }],
  gaps: ['No Kubernetes']
})

describe('profileChanges', () => {
  it('is 0 for the same profile, and ignores what the file cannot hold (blank lines, trailing spaces)', () => {
    const p = base()
    expect(profileChanges(p, base())).toBe(0)
    const loose = { ...p, summary: 'Backend engineer.  \n', gaps: ['No Kubernetes', ''], experience: [{ ...p.experience[0], highlights: ['Shipped **things**.', '  '] }] }
    expect(profileChanges(loose, p)).toBe(0)
  })

  it('counts each changed text field once', () => {
    const p = base()
    const edited = { ...p, contact: { ...p.contact, name: 'Alex R.', email: 'a@b.c' }, summary: 'Staff engineer.' }
    expect(profileChanges(edited, p)).toBe(3)
  })

  it('counts a list of lines or a comma list as one field', () => {
    const p = base()
    const edited = {
      ...p,
      skills: [{ category: 'Languages', items: ['Go', 'Python', 'Rust', 'SQL'] }],
      experience: [{ ...p.experience[0], highlights: ['One.', 'Two.', 'Three.'] }]
    }
    expect(profileChanges(edited, p)).toBe(2)
  })

  it('counts an added or removed entry as one field', () => {
    const p = base()
    expect(profileChanges({ ...p, experience: [...p.experience, emptyExperience()] }, p)).toBe(1)
    expect(profileChanges({ ...p, experience: [] }, p)).toBe(1)
  })
})

describe('countChanges', () => {
  it('compares plain values, records and lists', () => {
    expect(countChanges('a', 'a')).toBe(0)
    expect(countChanges('a', 'b')).toBe(1)
    expect(countChanges({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toBe(2)
    expect(countChanges([{ a: 1 }, { a: 2 }], [{ a: 1 }])).toBe(1)
    expect(countChanges(['x'], ['x'])).toBe(0)
  })
})

describe('leave guard text', () => {
  it('says how many fields would be lost and that the file is untouched', () => {
    expect(fieldsLabel(1)).toBe('1 field')
    expect(fieldsLabel(3)).toBe('3 fields')
    expect(leaveMessage(3, 'master-profile.md')).toBe(
      'The master profile has 3 unsaved fields. Leaving the page throws them away; master-profile.md on disk is not touched.'
    )
    expect(leaveMessage(1, 'master-profile.md')).toBe(
      'The master profile has 1 unsaved field. Leaving the page throws it away; master-profile.md on disk is not touched.'
    )
  })
})
