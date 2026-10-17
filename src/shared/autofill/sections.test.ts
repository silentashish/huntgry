import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { workdayWidgets } from '../../../scripts/mock-ats/workday.mjs'
import type { PageAnswers } from '../apply-facts'
import type { FieldReport, FillProfile, FillReport } from '../apply-types'
import { fillProfileFrom, parseMonthYear } from '../apply-values'
import { emptyProfile } from '../master-profile'
import { fillPage, fillSections, pendingPicks, pickAnswers, scanPage } from './engine'
import { testValues } from './fixtures/values'
import { bestMatch, degreeOption, fullDate, matchBlocks } from './sections'
import { watchUserEdits } from './user-edits'

/**
 * Workday's repeatable sections (#136) against the mock Workday's widgets
 * (scripts/mock-ats/workday.mjs): blocks added with the section's own Add
 * button and filled from the profile, the resume parser's guesses replaced,
 * the person's own values kept, skills picked; and the answer-only steps.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const URL_ = 'https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/Remote-USA/Software-Engineer_JR-1001/apply/applyManually'
const VALUES = testValues({ location: 'Portland, OR' })

const PROFILE: FillProfile = {
  experience: [
    {
      company: 'Acme Corp',
      role: 'Senior Backend Engineer',
      location: 'Remote',
      start: { month: 1, year: 2022 },
      end: null,
      current: true,
      description: 'Rebuilt the billing API.\nLed a team of four.'
    },
    {
      company: 'Globex Corporation',
      role: 'Software Engineer',
      location: 'Portland, OR',
      start: { month: 6, year: 2018 },
      end: { month: 12, year: 2021 },
      current: false,
      description: 'Migrated nightly reports.'
    }
  ],
  education: [{ school: 'State University', degree: 'Bachelor of Science', field: 'Computer Science', gpa: '3.8', start: { month: 8, year: 2014 }, end: { month: 5, year: 2018 } }],
  skills: ['Go', 'Python', 'TypeScript', 'SQL', 'AWS', 'Terraform', 'Docker', 'PostgreSQL', 'Cobol'],
  websites: ['https://github.com/ada']
}

/** A Workday page with the mock's widgets; edits counted only when a test marks them (`userTypes`). */
function workday(name: string): JSDOM {
  const dom = new JSDOM(fixture(name), { url: URL_, runScripts: 'outside-only' })
  dom.window.eval(`(${workdayWidgets.toString()})()`)
  watchUserEdits(dom.window.document, { isUserEvent: (e) => (e as Event & { user?: boolean }).user === true })
  return dom
}

/** The person types into a field (an input event the edit watcher counts as theirs). */
function userTypes(dom: JSDOM, el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value
  const event = new dom.window.Event('input', { bubbles: true }) as Event & { user?: boolean }
  event.user = true
  el.dispatchEvent(event)
}

const $ = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector) as HTMLInputElement
const val = (dom: JSDOM, selector: string) => $(dom, selector)?.value ?? null
const line = (report: FillReport, label: string): FieldReport => {
  const found = report.fields.find((f) => f.label === label)
  if (!found) throw new Error(`No line "${label}" in ${report.fields.map((f) => f.label).join(' | ')}`)
  return found
}

/** Every press, click and submit, and every key, in the page. */
function watchPresses(dom: JSDOM) {
  const pressed: string[] = []
  for (const type of ['click', 'submit', 'keydown']) {
    dom.window.document.addEventListener(
      type,
      (e) => {
        const el = e.target as Element
        pressed.push(`${type}:${el.getAttribute?.('data-automation-id') ?? el.id ?? el.tagName}`)
      },
      true
    )
  }
  return pressed
}

async function fill(dom: JSDOM, options: { pick?: boolean; profile?: FillProfile | null; answers?: PageAnswers } = {}) {
  const report = fillPage(dom.window.document, VALUES, {
    pick: options.pick ?? true,
    profile: options.profile === null ? undefined : (options.profile ?? PROFILE),
    answers: options.answers
  })
  await fillSections(report)
  if (pendingPicks(report).length) await pickAnswers(report)
  return report
}

describe('profile sections from the master profile (#136)', () => {
  it('parses month and year in the usual resume forms, and Present as none', () => {
    expect(parseMonthYear('Jan 2022')).toEqual({ month: 1, year: 2022 })
    expect(parseMonthYear('September 2019')).toEqual({ month: 9, year: 2019 })
    expect(parseMonthYear('2022-01')).toEqual({ month: 1, year: 2022 })
    expect(parseMonthYear('01/2022')).toEqual({ month: 1, year: 2022 })
    expect(parseMonthYear('2020')).toEqual({ month: 1, year: 2020 })
    expect(parseMonthYear('Present')).toBeNull()
    expect(parseMonthYear('13/2022')).toBeNull()
    expect(parseMonthYear('soon')).toBeNull()
  })

  it('builds experience, education, skills (flattened, deduplicated, at most 40) and websites', () => {
    const profile = emptyProfile()
    profile.contact.github = 'github.com/ada'
    profile.contact.website = 'ada.example'
    profile.skills = [
      { category: 'Languages', items: ['Go', 'Python', 'go'] },
      { category: 'Lots', items: Array.from({ length: 50 }, (_, i) => `Skill ${i}`) }
    ]
    profile.experience = [
      { company: 'Acme', role: 'Engineer', start: 'Jan 2022', end: 'Present', location: '', employmentType: '', project: '', projectLink: '', technologies: '', highlights: ['Cut **40%**', 'x'.repeat(3000)] },
      { company: 'Globex', role: 'Dev', start: '2018-06', end: '12/2021', location: 'Portland', employmentType: '', project: '', projectLink: '', technologies: '', highlights: [] }
    ]
    profile.education = [{ institution: 'State U', degree: 'BS', field: 'CS', start: 'Aug 2014', end: 'May 2018', location: '', gpa: '3.9', highlights: [] }]
    const out = fillProfileFrom(profile)
    expect(out.experience[0]).toMatchObject({ company: 'Acme', current: true, start: { month: 1, year: 2022 }, end: null })
    expect(out.experience[0].description.startsWith('Cut 40%\n')).toBe(true)
    expect(out.experience[0].description).toHaveLength(2000)
    expect(out.experience[1]).toMatchObject({ current: false, start: { month: 6, year: 2018 }, end: { month: 12, year: 2021 } })
    expect(out.education[0]).toMatchObject({ school: 'State U', degree: 'BS', gpa: '3.9', end: { month: 5, year: 2018 } })
    expect(out.skills.slice(0, 3)).toEqual(['Go', 'Python', 'Skill 0'])
    expect(out.skills).toHaveLength(40)
    expect(out.websites).toEqual(['https://github.com/ada', 'https://ada.example'])
  })
})

describe('Workday My Experience: sections (#136)', () => {
  it('adds a block per job, school and website with the section’s Add button and fills it from the profile', { timeout: 30_000 }, async () => {
    const dom = workday('workday-my-experience.html')
    const pressed = watchPresses(dom)
    const report = await fill(dom)

    // Work experience: two blocks added, filled; the current job ticked, its end date left alone.
    expect(val(dom, '#workExperience-1--jobTitle')).toBe('Senior Backend Engineer')
    expect(val(dom, '#workExperience-1--companyName')).toBe('Acme Corp')
    expect(val(dom, '#workExperience-1--location')).toBe('Remote')
    expect($(dom, '#workExperience-1--currentlyWorkHere').checked).toBe(true)
    expect(val(dom, '#workExperience-1--startDate-dateSectionMonth-input')).toBe('01')
    expect(val(dom, '#workExperience-1--startDate-dateSectionYear-input')).toBe('2022')
    expect(val(dom, '#workExperience-1--endDate-dateSectionYear-input')).toBe('')
    expect(val(dom, '#workExperience-1--roleDescription')).toBe('Rebuilt the billing API.\nLed a team of four.')
    expect(val(dom, '#workExperience-2--jobTitle')).toBe('Software Engineer')
    expect(val(dom, '#workExperience-2--companyName')).toBe('Globex Corporation')
    expect($(dom, '#workExperience-2--currentlyWorkHere').checked).toBe(false)
    expect(val(dom, '#workExperience-2--startDate-dateSectionMonth-input')).toBe('06')
    expect(val(dom, '#workExperience-2--endDate-dateSectionMonth-input')).toBe('12')
    expect(val(dom, '#workExperience-2--endDate-dateSectionYear-input')).toBe('2021')
    expect(dom.window.document.querySelectorAll('[data-automation-id="workExperienceSection-blocks"] > [role="group"]')).toHaveLength(2)
    expect(line(report, 'Work experience 1 · Job title')).toMatchObject({ key: null, kind: 'text', outcome: 'filled', value: 'Senior Backend Engineer' })
    expect(line(report, 'Work experience 1 · I currently work here')).toMatchObject({ outcome: 'filled' })
    expect(line(report, 'Work experience 2 · To')).toMatchObject({ outcome: 'filled', value: '12/2021' })
    expect(report.fields.some((f) => f.label === 'Work experience 1 · To')).toBe(false)

    // Education: the school and field of study picked from Workday's prompts, the degree by synonym.
    expect(dom.window.document.querySelector('#education-1 [data-automation-id="formField-school"] [data-automation-id="selectedItem"]')?.getAttribute('data-automation-label')).toBe(
      'State University'
    )
    expect($(dom, '#education-1--degree').textContent).toBe("Bachelor's Degree")
    expect(line(report, 'Education 1 · Degree')).toMatchObject({ outcome: 'filled', value: "Bachelor's Degree" })
    expect(line(report, 'Education 1 · Field of study')).toMatchObject({ outcome: 'filled', value: 'Computer Science' })
    expect(val(dom, '#education-1--gpa')).toBe('3.8')
    expect(val(dom, '#education-1--firstYearAttended-dateSectionYear-input')).toBe('2014')
    expect(val(dom, '#education-1--lastYearAttended-dateSectionYear-input')).toBe('2018')

    // Websites: GitHub in the one block added.
    expect(val(dom, '#website-1--url')).toBe('https://github.com/ada')

    // Skills: each typed and picked as a pill; one not in Workday's list is reported.
    const pills = Array.from(dom.window.document.querySelectorAll('[data-automation-id="formField-skills"] [data-automation-id="selectedItem"]')).map((p) =>
      p.getAttribute('data-automation-label')
    )
    expect(pills).toEqual(['Go', 'Python', 'TypeScript', 'SQL', 'AWS', 'Terraform', 'Docker', 'PostgreSQL'])
    const skills = report.fields.find((f) => f.label.startsWith('Skills:'))!
    expect(skills).toMatchObject({ label: 'Skills: 8 added, 1 not found', outcome: 'filled' })
    expect(skills.reason).toContain('Cobol')

    // Only the sections' Add buttons, the toggle, the dropdown and prompt suggestions were pressed; never the footer,
    // never a Delete button. Keys only as Enter in Workday's search boxes.
    const clicks = pressed.filter((p) => p.startsWith('click:'))
    expect(clicks.filter((c) => c === 'click:Add')).toHaveLength(4)
    expect(clicks.some((c) => /next|Back|delete|footer/i.test(c))).toBe(false)
    expect(pressed.filter((p) => p.startsWith('submit'))).toEqual([])
    expect(pressed.filter((p) => p.startsWith('keydown:')).every((k) => k === 'keydown:searchBox')).toBe(true)
    // Nothing else on the page: LinkedIn still filled by the engine, the resume still marked.
    expect(val(dom, '[data-automation-id="linkedinQuestion"]')).toBe(VALUES.linkedin)
    expect(report.fields.find((f) => f.key === 'resume')?.outcome).toBe('to-upload')
  })

  it('replaces the resume parser’s guesses in a block it matched by company, and keeps what the person typed', { timeout: 30_000 }, async () => {
    const dom = workday('workday-my-experience.html')
    const w = dom.window as unknown as { huntgryWorkdayAddBlock: (kind: string, values: object) => void }
    w.huntgryWorkdayAddBlock('experience', { jobTitle: 'Developer', company: 'Globex Corporation', start: { Month: '05', Year: '2018' } })
    w.huntgryWorkdayAddBlock('experience', { jobTitle: 'Engineer', company: 'Acme Corp', start: { Month: '02', Year: '2021' } })
    // The person corrected the second block's location themselves.
    userTypes(dom, $(dom, '#workExperience-2--location'), 'Berlin')
    const pressed = watchPresses(dom)
    const report = await fill(dom)

    // Enough blocks already: Work Experience's Add is never pressed (Education's and Websites' are, once each).
    expect(pressed.filter((p) => p === 'click:Add')).toHaveLength(2)
    expect(dom.window.document.querySelectorAll('[data-automation-id="workExperienceSection-blocks"] > [role="group"]')).toHaveLength(2)
    // Each block got its own company's entry.
    expect(val(dom, '#workExperience-1--jobTitle')).toBe('Software Engineer')
    expect(val(dom, '#workExperience-1--startDate-dateSectionMonth-input')).toBe('06')
    expect(val(dom, '#workExperience-2--jobTitle')).toBe('Senior Backend Engineer')
    expect(val(dom, '#workExperience-2--startDate-dateSectionMonth-input')).toBe('01')
    expect(val(dom, '#workExperience-2--startDate-dateSectionYear-input')).toBe('2022')
    expect(line(report, 'Work experience 1 · Job title')).toMatchObject({ outcome: 'filled', reason: "Replaced the site's parsed value." })
    // Lines are numbered by the profile's entries: "Work experience 1" is Acme, in the page's second block.
    expect(line(report, 'Work experience 1 · From')).toMatchObject({ outcome: 'filled', value: '01/2022', reason: "Replaced the site's parsed value." })
    expect(line(report, 'Work experience 2 · From')).toMatchObject({ outcome: 'filled', value: '06/2018', reason: "Replaced the site's parsed value." })
    expect(val(dom, '#workExperience-2--location')).toBe('Berlin')
    expect(line(report, 'Work experience 1 · Location')).toMatchObject({ outcome: 'kept', value: 'Berlin' })
  })

  it('without the pick switch: types into blocks that exist, presses nothing, and leaves Add to the person', async () => {
    const dom = workday('workday-my-experience.html')
    ;(dom.window as unknown as { huntgryWorkdayAddBlock: (kind: string, values: object) => void }).huntgryWorkdayAddBlock('experience', {})
    const pressed = watchPresses(dom)
    const report = await fill(dom, { pick: false })
    expect(pressed).toEqual([])
    expect(val(dom, '#workExperience-1--jobTitle')).toBe('Senior Backend Engineer')
    expect($(dom, '#workExperience-1--currentlyWorkHere').checked).toBe(false)
    expect(line(report, 'Work experience 1 · I currently work here')).toMatchObject({ outcome: 'skipped-unsupported' })
    expect(line(report, 'Work experience 2')).toMatchObject({ outcome: 'skipped-unsupported', reason: expect.stringMatching(/Press Add/) })
    expect(report.fields.find((f) => f.label.startsWith('Skills:'))?.reason).toMatch(/picking is off/)
  })

  it('leaves the sections alone when main sends no profile, and never reports their controls as questions', async () => {
    const dom = workday('workday-my-experience.html')
    ;(dom.window as unknown as { huntgryWorkdayAddBlock: (kind: string, values: object) => void }).huntgryWorkdayAddBlock('experience', {})
    const pressed = watchPresses(dom)
    const report = await fill(dom, { profile: null })
    expect(pressed).toEqual([])
    expect(val(dom, '#workExperience-1--jobTitle')).toBe('')
    // The block's Location is not mistaken for the contact location, nor any block field for a question.
    expect(report.fields.map((f) => f.label)).toEqual(expect.not.arrayContaining(['Job Title', 'Location', 'Company', 'Type to Add Skills']))
    expect(report.fields.filter((f) => f.key === 'location')).toEqual([])
  })

  it('ticks no other check box, and never a block’s Delete or the footer, even if a page handler re-sends the press', async () => {
    const dom = workday('workday-my-experience.html')
    const doc = dom.window.document
    const next = doc.querySelector('[data-automation-id="bottom-navigation-next-button"]') as HTMLButtonElement
    const nextClicked = vi.fn()
    next.addEventListener('click', nextClicked)
    // A hostile handler: pressing Add also clicks Save and Continue.
    doc.querySelector('[data-automation-id="workExperienceSection"] > button')!.addEventListener('click', () => {
      next.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const report = await fill(dom)
    expect(nextClicked).not.toHaveBeenCalled()
    expect(report.fields.some((f) => /Work experience: Add/.test(f.label) && f.outcome === 'rejected')).toBe(true)
  })
})

describe('Workday: answer-only steps (#136)', () => {
  const answers = {
    facts: { needsSponsorship: 'no', previouslyEmployed: 'no', howHeard: 'LinkedIn', salaryExpectation: '150000', earliestStart: '2027-03-01', gender: 'decline', veteranStatus: 'no', raceEthnicity: 'decline', disabilityStatus: 'decline' },
    questions: {}
  }

  it('Application Questions: facts written or picked; nothing matched to contact values; no upload', async () => {
    const dom = workday('workday-application-questions.html')
    expect(scanPage(dom.window.document)).toMatchObject({ step: 'form', stepTitle: 'Application Questions', formFound: true })
    const report = await fill(dom, { answers })
    expect($(dom, '#primaryQuestionnaire--sponsorship').textContent).toBe('No')
    expect(line(report, 'Will you now or in the future require sponsorship for employment visa status?')).toMatchObject({ outcome: 'filled', value: 'No' })
    expect($(dom, '#primaryQuestionnaire--previouslyWorked-1').checked).toBe(true)
    expect(val(dom, '#primaryQuestionnaire--salary')).toBe('150000')
    expect(dom.window.document.querySelector('[data-automation-id="formField-source"] [data-automation-id="selectedItem"]')?.getAttribute('data-automation-label')).toBe('LinkedIn')
    // The earliest start date (a full date) in Workday's spinbuttons.
    expect(val(dom, '#primaryQuestionnaire--earliestStart-dateSectionMonth-input')).toBe('03')
    expect(val(dom, '#primaryQuestionnaire--earliestStart-dateSectionDay-input')).toBe('01')
    expect(val(dom, '#primaryQuestionnaire--earliestStart-dateSectionYear-input')).toBe('2027')
    expect(line(report, 'What is your earliest start date?')).toMatchObject({ outcome: 'filled', value: '03/01/2027' })
    expect(report.fields.every((f) => f.key === null)).toBe(true)
    expect(report.fields.some((f) => f.label === 'Month' || f.label === 'Day')).toBe(false)
  })

  it('an earliest start that is not a full date is only a suggestion', async () => {
    const dom = workday('workday-application-questions.html')
    const report = await fill(dom, { answers: { ...answers, facts: { earliestStart: 'Two weeks after an offer' } } })
    expect(val(dom, '#primaryQuestionnaire--earliestStart-dateSectionMonth-input')).toBe('')
    expect(line(report, 'What is your earliest start date?')).toMatchObject({ outcome: 'skipped-unsupported', reason: expect.stringContaining('Two weeks') })
  })

  it('Voluntary Disclosures: EEO dropdowns picked from stored facts; the terms check box untouched', async () => {
    const dom = workday('workday-voluntary-disclosures.html')
    const report = await fill(dom, { answers })
    expect($(dom, '#personalInfoUS--gender').textContent).toBe('I do not wish to self-identify')
    expect($(dom, '#personalInfoUS--veteranStatus').textContent).toBe('I am not a protected veteran')
    expect($(dom, '#personalInfoUS--ethnicity').textContent).toBe('I do not wish to self-identify')
    expect($(dom, '#termsAndConditions--acceptTermsAndAgreements').checked).toBe(false)
    expect(report.fields.some((f) => /terms/i.test(f.label))).toBe(false)
  })

  it('Self Identify: disability picked from the fact (decline); the signature block never touched or reported', async () => {
    const dom = workday('workday-self-identify.html')
    const report = await fill(dom, { answers })
    expect($(dom, '#selfIdentifiedDisabilityData--disabilityStatus-2').checked).toBe(true)
    expect(val(dom, '#selfIdentifiedDisabilityData--name')).toBe('')
    for (const part of ['Month', 'Day', 'Year']) expect(val(dom, `#selfIdentifiedDisabilityData--dateSignedOn-dateSection${part}-input`)).toBe('')
    expect(report.fields.map((f) => f.label)).toEqual(['Disability Status'])
  })

  it('Self Identify with check boxes: only the box the fact names is ticked', async () => {
    const dom = workday('workday-self-identify.html')
    const field = dom.window.document.querySelector('[data-automation-id="formField-disabilityStatus"]')!
    field.innerHTML = `<fieldset><legend>Please check one of the boxes below</legend>
      <input type="checkbox" id="dis-yes"><label for="dis-yes">Yes, I have a disability</label>
      <input type="checkbox" id="dis-no"><label for="dis-no">No, I do not have a disability</label>
      <input type="checkbox" id="dis-decline"><label for="dis-decline">I do not want to answer</label></fieldset>`
    const report = await fill(dom, { answers: { ...answers, facts: { disabilityStatus: 'no' } } })
    expect(['dis-yes', 'dis-no', 'dis-decline'].map((id) => $(dom, `#${id}`).checked)).toEqual([false, true, false])
    expect(line(report, 'Please check one of the boxes below')).toMatchObject({ outcome: 'filled', value: 'No, I do not have a disability' })
  })

  it('Review is never filled', async () => {
    const dom = workday('workday-review.html')
    const pressed = watchPresses(dom)
    expect(scanPage(dom.window.document)).toMatchObject({ step: 'other', stepTitle: 'Review' })
    const report = await fill(dom, { answers })
    expect(report.fields).toEqual([])
    expect(pressed).toEqual([])
  })
})

describe('section helpers', () => {
  it('degree synonyms', () => {
    const options = ['High School Diploma', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'MBA', 'Doctorate (PhD)']
    expect(degreeOption('Bachelor of Science', options)).toBe("Bachelor's Degree")
    expect(degreeOption('B.S.', options)).toBe("Bachelor's Degree")
    expect(degreeOption("Master's", options)).toBe("Master's Degree")
    expect(degreeOption('M.S. in CS', options)).toBe("Master's Degree")
    expect(degreeOption('PhD', options)).toBe('Doctorate (PhD)')
    expect(degreeOption('Bachelors', ['BS', 'BA'])).toBeNull()
    expect(degreeOption('Bachelor of Science', ['Bachelor of Arts', 'Bachelor of Science'])).toBe('Bachelor of Science')
    expect(degreeOption('BS', ['Bachelor of Arts', 'Bachelor of Science'])).toBe('Bachelor of Science')
  })

  it('best match, full dates and block pairing', () => {
    expect(bestMatch('Go', ['Golang', 'Go', 'Django'])).toBe('Go')
    expect(bestMatch('Go', ['Go (Programming Language)', 'Google Cloud'])).toBe('Go (Programming Language)')
    expect(bestMatch('Go', ['Django', 'Google Cloud'])).toBeNull()
    expect(fullDate('2027-03-01')).toEqual({ day: 1, month: 3, year: 2027 })
    expect(fullDate('March 1, 2027')).toEqual({ day: 1, month: 3, year: 2027 })
    expect(fullDate('02/30/2027')).toBeNull()
    expect(fullDate('2 weeks')).toBeNull()
    const doc = new JSDOM('<div id="a">Globex</div><div id="b"></div>').window.document
    const blocks = [doc.getElementById('a')!, doc.getElementById('b')!]
    const pairs = matchBlocks(blocks, ['Acme Corp', 'Globex Corporation'], (b) => b.textContent ?? '', (e) => e)
    expect(pairs.map(([b, e]) => `${b.id}:${e}`)).toEqual(['a:Globex Corporation', 'b:Acme Corp'])
  })
})
