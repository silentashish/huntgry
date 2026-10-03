import { describe, expect, it } from 'vitest'
import type { FieldReport } from '@shared/apply-types'
import { groupReport, stepLabel } from './apply-report'

const f = (label: string, outcome: FieldReport['outcome'], required = false): FieldReport => ({
  key: null,
  label,
  kind: 'text',
  required,
  outcome
})

describe('groupReport', () => {
  it('puts what needs the user first, required fields on top', () => {
    const groups = groupReport({
      ats: 'greenhouse',
      url: 'https://x.example',
      hasSubmitButton: true,
      fields: [
        f('Email', 'filled', true),
        f('Why us?', 'unmatched'),
        f('Salary', 'unmatched', true),
        f('Country', 'skipped-unsupported', true),
        f('Resume', 'uploaded', true),
        f('Phone', 'rejected')
      ]
    })
    expect(groups.map((g) => g.title)).toEqual(['Needs you', 'Filled', 'Your choice'])
    expect(groups[0].fields.map((x) => x.label)).toEqual(['Salary', 'Why us?', 'Phone'])
    expect(groups[1].fields.map((x) => x.label)).toEqual(['Email', 'Resume'])
  })

  it('is empty without a report and drops empty groups', () => {
    expect(groupReport(null)).toEqual([])
    const groups = groupReport({ ats: 'lever', url: '', hasSubmitButton: false, fields: [f('Name', 'filled')] })
    expect(groups.map((g) => g.title)).toEqual(['Filled'])
  })
})

describe('stepLabel', () => {
  it('names the step of a multi-step site, by its title on form steps', () => {
    expect(stepLabel(null)).toBeNull()
    expect(stepLabel(undefined)).toBeNull()
    expect(stepLabel({ kind: 'form', title: 'My Information' })).toBe('Step: My Information')
    expect(stepLabel({ kind: 'form', title: null })).toBe('Step: Application form')
    expect(stepLabel({ kind: 'posting', title: 'Job posting' })).toBe('Step: Job posting')
    expect(stepLabel({ kind: 'account-wall', title: 'Create Account/Sign In' })).toBe(
      'Step: Sign in or create account (Create Account/Sign In)'
    )
    expect(stepLabel({ kind: 'other', title: 'Application Questions' })).toBe('Step: Other step (Application Questions)')
  })
})
