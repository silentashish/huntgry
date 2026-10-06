import { describe, expect, it } from 'vitest'
import { boundedOption, canonicalAnswer, factsFromProfile, matchFact, questionKey, resolveAnswer, yesNoOf } from './apply-facts'

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
    // Inverse age wording would flip the answer: left to the user.
    expect(matchFact('Are you under 18 years of age?')).toBeNull()
    expect(matchFact('Are you younger than 18?')).toBeNull()
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

  it('keeps "I do not want to answer" a decline, apart from the No option', () => {
    const disability = ['Yes, I have a disability', 'No, I do not have a disability', 'I do not want to answer']
    expect(resolveAnswer('disabilityStatus', 'no', 'radio', disability)).toBe('No, I do not have a disability')
    expect(resolveAnswer('disabilityStatus', 'decline', 'radio', disability)).toBe('I do not want to answer')
    expect(canonicalAnswer('disabilityStatus', 'I do not want to answer')).toBe('decline')
    expect(canonicalAnswer('disabilityStatus', "I don't want to answer")).toBe('decline')
    // Saved from that form, reused on one offering Yes / No / Prefer not to say: the decline, never "No".
    expect(resolveAnswer('disabilityStatus', canonicalAnswer('disabilityStatus', 'I do not want to answer'), 'select', ['Yes', 'No', 'Prefer not to say'])).toBe(
      'Prefer not to say'
    )
    expect(resolveAnswer('disabilityStatus', canonicalAnswer('disabilityStatus', 'No, I do not have a disability'), 'select', ['Yes', 'No', 'Prefer not to say'])).toBe(
      'No'
    )
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
    expect(factsFromProfile('U.S. citizen')).toEqual({ workAuthorized: 'yes', needsSponsorship: 'no' })
    expect(factsFromProfile('Permanent resident of the United States')).toEqual({ workAuthorized: 'yes', needsSponsorship: 'no' })
    // Negated, foreign or unqualified status says nothing about working in the US.
    expect(factsFromProfile('Not a US citizen')).toEqual({})
    expect(factsFromProfile('Indian citizen')).toEqual({})
    expect(factsFromProfile('Citizen')).toEqual({})
    expect(factsFromProfile('Canadian permanent resident')).toEqual({})
    expect(factsFromProfile('Not a permanent resident')).toEqual({})
    expect(factsFromProfile('Green card pending')).toEqual({})
    expect(factsFromProfile('')).toEqual({})
  })

  it('keys a question by its text, kind group and options, not by element ids', () => {
    const a = questionKey('Will you require visa sponsorship?*', 'radio', ['Yes', 'No'])
    expect(questionKey('will you require visa sponsorship', 'select', ['no', 'yes'])).toBe(a)
    expect(questionKey('Will you require visa sponsorship?', 'radio', ['Yes', 'No', 'Maybe'])).not.toBe(a)
    expect(questionKey('Why us?', 'textarea')).toBe(questionKey('Why us', 'text'))
  })
})

describe('boundedOption', () => {
  it('keeps short options and names long ones by prefix and hash, apart even with the same start', () => {
    expect(boundedOption('Yes')).toBe('Yes')
    const a = `${'I identify as one of the protected veteran classifications listed in the explanation above, '.repeat(2)}A`
    const b = `${a.slice(0, -1)}B`
    expect(boundedOption(a).length).toBeLessThanOrEqual(120)
    expect(boundedOption(a)).not.toBe(boundedOption(b))
    expect(boundedOption(a)).toBe(boundedOption(a))
  })
})
