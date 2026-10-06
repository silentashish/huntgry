import { describe, expect, it } from 'vitest'
import { canonicalAnswer, factsFromProfile, matchFact, questionKey, resolveAnswer, yesNoOf } from './apply-facts'

describe('matchFact', () => {
  it.each([
    ['Are you legally authorized to work in the United States?', 'workAuthorized'],
    ['Are you authorized to work in the country?', 'workAuthorized'],
    ['Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)?', 'needsSponsorship'],
    ['Will you require visa sponsorship?', 'needsSponsorship'],
    ['Are you legally authorized to work in the US without sponsorship?', 'workAuthorized'],
    ['Are you 18 years of age or older?', 'over18'],
    ['Are you willing to relocate?', 'willingToRelocate'],
    ['What is your notice period?', 'noticePeriod'],
    ['What are your salary expectations?', 'salaryExpectation'],
    ['Desired salary', 'salaryExpectation'],
    ['When can you start?', 'earliestStart'],
    ['Gender', 'gender'],
    ['Gender (optional)', 'gender'],
    ['Are you Hispanic/Latino?', 'hispanicLatino'],
    ['Race', 'raceEthnicity'],
    ['Veteran Status', 'veteranStatus'],
    ['Disability Status', 'disabilityStatus'],
    ['Pronouns', 'pronouns']
  ])('%s → %s', (question, fact) => {
    expect(matchFact(question)).toBe(fact)
  })

  it('never matches consent, certification or unrelated questions', () => {
    expect(matchFact('I certify that I am authorized to work and that the above is true')).toBeNull()
    expect(matchFact('I acknowledge the Arbitration Agreement (veteran benefits explained)')).toBeNull()
    expect(matchFact('Sexual orientation')).toBeNull()
    expect(matchFact('Do you identify as transgender?')).toBeNull()
    expect(matchFact('Why do you want to work here?')).toBeNull()
    expect(matchFact('')).toBeNull()
  })
})

describe('resolveAnswer', () => {
  const lever = ['Male', 'Female', 'Decline to self-identify']

  it('picks the same option, a synonym, the decline option or the single yes/no', () => {
    expect(resolveAnswer('gender', 'female', 'select', lever)).toBe('Female')
    expect(resolveAnswer('gender', 'Woman', 'select', lever)).toBe('Female')
    expect(resolveAnswer('gender', 'decline', 'select', lever)).toBe('Decline to self-identify')
    expect(resolveAnswer('gender', 'decline', 'radio', ['Man', 'Woman', "I don't wish to answer"])).toBe("I don't wish to answer")
    expect(resolveAnswer('veteranStatus', 'no', 'radio', ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', "I don't wish to answer"])).toBe(
      'I am not a protected veteran'
    )
    expect(resolveAnswer('disabilityStatus', 'yes', 'radio', ['Yes, I have a disability', 'No, I do not have a disability', 'I do not want to answer'])).toBe(
      'Yes, I have a disability'
    )
    expect(resolveAnswer('workAuthorized', 'yes', 'radio', ['Yes', 'No'])).toBe('Yes')
  })

  it('returns null when nothing fits, never guessing', () => {
    expect(resolveAnswer('gender', 'decline', 'select', ['Male', 'Female'])).toBeNull()
    expect(resolveAnswer('gender', 'Non-binary', 'select', ['Male', 'Female'])).toBeNull()
    expect(resolveAnswer('workAuthorized', 'yes', 'radio', ['Yes, I am', 'Yes, with a visa', 'No'])).toBeNull()
    expect(resolveAnswer(null, '', 'text', [])).toBeNull()
  })

  it('words a yes/no for a typed field, never types "decline", and suggests text for pickers', () => {
    expect(resolveAnswer('needsSponsorship', 'no', 'text', [])).toBe('No')
    expect(resolveAnswer('gender', 'decline', 'textarea', [])).toBeNull()
    expect(resolveAnswer('salaryExpectation', '$150k', 'text', [])).toBe('$150k')
    expect(resolveAnswer('workAuthorized', 'yes', 'combobox', [])).toBe('Yes')
  })
})

describe('stored answers', () => {
  it('stores yes/no facts as yes, no or decline', () => {
    expect(canonicalAnswer('needsSponsorship', 'No')).toBe('no')
    expect(canonicalAnswer('veteranStatus', 'I am not a protected veteran')).toBe('no')
    expect(canonicalAnswer('gender', 'Decline to self-identify')).toBe('decline')
    expect(canonicalAnswer('gender', 'Female')).toBe('Female')
    expect(canonicalAnswer('noticePeriod', ' 2 weeks ')).toBe('2 weeks')
    expect(yesNoOf("I don't wish to answer")).toBeNull()
  })

  it('reads authorization from the profile only when it is unambiguous', () => {
    expect(factsFromProfile('US Citizen')).toEqual({ workAuthorized: 'yes', needsSponsorship: 'no' })
    expect(factsFromProfile('Green card holder')).toEqual({ workAuthorized: 'yes', needsSponsorship: 'no' })
    expect(factsFromProfile('H-1B visa (transfer needed)')).toEqual({})
    expect(factsFromProfile('F-1 OPT')).toEqual({})
    expect(factsFromProfile('')).toEqual({})
  })

  it('keys a question by its text, kind group and options, not by element ids', () => {
    const a = questionKey('Will you require visa sponsorship?*', 'radio', ['Yes', 'No'])
    expect(questionKey('will you require visa sponsorship', 'select', ['no', 'yes'])).toBe(a)
    expect(questionKey('Will you require visa sponsorship?', 'radio', ['Yes', 'No', 'Maybe'])).not.toBe(a)
    expect(questionKey('Why us?', 'textarea')).toBe(questionKey('Why us', 'text'))
  })
})
