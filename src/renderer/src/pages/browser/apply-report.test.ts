import { describe, expect, it } from 'vitest'
import type { FieldReport } from '@shared/apply-types'
import { answerChoices, badgeOf, canAnswer, groupReport, stepLabel, suggestionNote } from './apply-report'

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

describe('answers in the panel (#71)', () => {
  const q = (extra: Partial<FieldReport>): FieldReport => ({
    ...f('Gender', 'skipped-unsupported'),
    kind: 'select',
    fieldId: 'select:g',
    question: 'choice|gender|0',
    ...extra
  })

  it('lists a choice Huntgry can learn (a fact or a suggestion) under "Needs you", other choices under "Your choice"', () => {
    const groups = groupReport({
      ats: 'lever',
      url: 'https://x.example',
      hasSubmitButton: true,
      fields: [q({ label: 'Gender', fact: 'gender' }), q({ label: 'Authorized', suggestion: 'Yes', suggestedBy: 'saved' }), q({ label: 'Country' })]
    })
    expect(groups.map((g) => [g.title, g.fields.map((f) => f.label)])).toEqual([
      ['Needs you', ['Gender', 'Authorized']],
      ['Your choice', ['Country']]
    ])
    expect(badgeOf(q({ fact: 'gender' }))).toEqual({ label: 'Answer once', color: 'orange' })
    expect(badgeOf(q({}))).toEqual({ label: 'Your choice', color: 'gray' })
    expect(badgeOf(q({ fact: 'gender', outcome: 'filled' })).label).toBe('Filled')
  })

  it('offers an answer for reported questions that are still open', () => {
    expect(canAnswer(q({}))).toBe(true)
    expect(canAnswer(q({ outcome: 'filled' }))).toBe(false)
    expect(canAnswer(q({ outcome: 'kept' }))).toBe(false)
    expect(canAnswer(f('Email', 'unmatched'))).toBe(false)
  })

  it('puts "decline" first for sensitive questions only', () => {
    const options = ['Male', 'Female', 'Decline to self-identify']
    expect(answerChoices(q({ fact: 'gender', options }))).toEqual(['Decline to self-identify', 'Male', 'Female'])
    expect(answerChoices(q({ fact: 'workAuthorized', options: ['Yes', 'No', 'Prefer not to say'] }))).toEqual(['Yes', 'No', 'Prefer not to say'])
  })

  it("says whether a suggestion is the user's own or the model's", () => {
    expect(suggestionNote(q({}))).toBeNull()
    expect(suggestionNote(q({ suggestion: 'Yes', suggestedBy: 'saved' }))).toMatch(/saved answers: "Yes". Pick it in the page/)
    expect(suggestionNote(q({ suggestion: 'Woman', suggestedBy: 'model', fact: 'gender' }))).toMatch(/AI matched this question to gender/)
  })
})
