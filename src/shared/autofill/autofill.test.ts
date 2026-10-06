import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { factsFromProfile, questionKey, type PageAnswers } from '../apply-facts'
import type { FieldReport, FillReport, FillValues } from '../apply-types'
import { UPLOAD_ATTR } from '../autofill-channels'
import { setNativeValue } from './dom'
import { detectConfirmation, fillPage, pendingPicks, pickAnswers, scanPage, verifyFill } from './engine'
import { watchUserEdits } from './user-edits'
import { identifierWords } from './match'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

function page(name: string, url: string): JSDOM {
  return new JSDOM(fixture(name), { url })
}

const VALUES: FillValues = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 555 123 4567',
  location: 'London, UK',
  linkedin: 'https://www.linkedin.com/in/ada',
  github: 'https://github.com/ada',
  website: 'https://ada.example',
  currentCompany: 'Analytical Engines'
}

/** Fails the test if anything submits, clicks or presses a key on the page. */
function forbidSubmit(dom: JSDOM) {
  const w = dom.window
  const submit = vi.spyOn(w.HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
  const requestSubmit = vi.spyOn(w.HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined)
  const click = vi.spyOn(w.HTMLElement.prototype, 'click')
  const events: string[] = []
  for (const type of ['submit', 'click', 'keydown', 'keypress', 'mousedown']) {
    w.document.addEventListener(type, () => events.push(type), true)
  }
  return () => {
    expect(submit).not.toHaveBeenCalled()
    expect(requestSubmit).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(events).toEqual([])
  }
}

const field = (report: FillReport, label: string): FieldReport => {
  const found = report.fields.find((f) => f.label === label)
  if (!found) throw new Error(`No field "${label}" in ${report.fields.map((f) => f.label).join(' | ')}`)
  return found
}

const input = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector) as HTMLInputElement

describe('Greenhouse', () => {
  const URL = 'https://job-boards.greenhouse.io/acme/jobs/1000001'

  it('detects the form and fills the contact fields', () => {
    const dom = page('greenhouse-form.html', URL)
    const check = forbidSubmit(dom)
    const scan = scanPage(dom.window.document)
    expect(scan).toMatchObject({
      ats: 'greenhouse',
      confirmation: false,
      formFound: true,
      hasResumeInput: true,
      embedUrl: null
    })

    const report = fillPage(dom.window.document, VALUES)
    expect(report.ats).toBe('greenhouse')
    expect(report.hasSubmitButton).toBe(true)
    expect(field(report, 'First Name')).toMatchObject({ key: 'firstName', outcome: 'filled', required: true })
    expect(field(report, 'Last Name')).toMatchObject({ key: 'lastName', outcome: 'filled' })
    expect(field(report, 'Email')).toMatchObject({ key: 'email', outcome: 'filled' })
    expect(field(report, 'Phone')).toMatchObject({ key: 'phone', outcome: 'filled' })
    expect(field(report, 'LinkedIn Profile')).toMatchObject({ key: 'linkedin', outcome: 'filled' })
    expect(field(report, "What's your current location (both city and state)?")).toMatchObject({
      key: 'location',
      outcome: 'filled'
    })
    expect(input(dom, '#first_name').value).toBe('Ada')
    expect(input(dom, '#email').value).toBe('ada@example.com')
    expect(input(dom, '#first_name').style.outline).toContain('solid')

    // The file input is marked for main's CDP upload, not touched.
    expect(field(report, 'Resume/CV')).toMatchObject({ key: 'resume', kind: 'file', outcome: 'to-upload' })
    expect(input(dom, '#resume').getAttribute(UPLOAD_ATTR)).toBe('resume')

    // Choices stay with the user.
    expect(field(report, 'Country')).toMatchObject({ kind: 'combobox', outcome: 'skipped-unsupported' })
    expect(field(report, 'Are you legally authorized to work in the United States?').outcome).toBe(
      'skipped-unsupported'
    )
    expect(input(dom, '#country').value).toBe('')
    // Custom questions are listed, not answered.
    expect(field(report, 'What are your salary expectations?')).toMatchObject({
      kind: 'textarea',
      outcome: 'unmatched'
    })
    expect(field(report, 'What is your notice period?').outcome).toBe('unmatched')
    check()
  })

  it('keeps what the user already typed', () => {
    const dom = page('greenhouse-form.html', URL)
    input(dom, '#first_name').value = 'Augusta'
    const report = fillPage(dom.window.document, VALUES)
    expect(field(report, 'First Name')).toMatchObject({ outcome: 'kept', value: 'Augusta' })
    expect(input(dom, '#first_name').value).toBe('Augusta')
  })

  it('reports values missing from the profile', () => {
    const dom = page('greenhouse-form.html', URL)
    const report = fillPage(dom.window.document, { ...VALUES, phone: '', linkedin: '' })
    expect(field(report, 'Phone').outcome).toBe('skipped-no-value')
    expect(field(report, 'LinkedIn Profile').outcome).toBe('skipped-no-value')
  })

  it('recognises the confirmation page', () => {
    const done = page('greenhouse-confirmation.html', `${URL}/confirmation`)
    expect(detectConfirmation(done.window.document)).toBe(true)
    expect(scanPage(done.window.document)).toMatchObject({ ats: 'greenhouse', confirmation: true })
    expect(detectConfirmation(page('greenhouse-form.html', URL).window.document)).toBe(false)
  })

  it('is detected by its markup on another host (mock ATS, custom domain)', () => {
    const dom = page('greenhouse-form.html', 'http://localhost:4173/greenhouse/')
    expect(scanPage(dom.window.document).ats).toBe('greenhouse')
  })

  it('finds an embedded /embed/job_app form on a company page', () => {
    const dom = page('greenhouse-embed-host.html', 'https://acme.example/careers/engineer')
    const scan = scanPage(dom.window.document)
    expect(scan.ats).toBe('generic')
    expect(scan.formFound).toBe(false)
    expect(scan.embedUrl).toBe(
      'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1000001&b=https%3A%2F%2Facme.example%2Fcareers'
    )
  })
})

describe('Lever', () => {
  const URL = 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001/apply'

  it('fills the named fields and leaves the rest to the user', () => {
    const dom = page('lever-form.html', URL)
    const check = forbidSubmit(dom)
    expect(scanPage(dom.window.document)).toMatchObject({ ats: 'lever', formFound: true, hasResumeInput: true })
    const report = fillPage(dom.window.document, VALUES)
    const byName = (name: string) => input(dom, `[name="${name}"]`).value
    expect(byName('name')).toBe('Ada Lovelace')
    expect(byName('email')).toBe('ada@example.com')
    expect(byName('phone')).toBe('+1 555 123 4567')
    // The location is an autocomplete that only takes a suggestion: a choice for the user (#63).
    expect(byName('location')).toBe('')
    expect(field(report, 'Current location')).toMatchObject({ kind: 'text', outcome: 'skipped-unsupported' })
    expect(byName('org')).toBe('Analytical Engines')
    expect(byName('urls[LinkedIn]')).toBe('https://www.linkedin.com/in/ada')
    expect(byName('urls[GitHub]')).toBe('https://github.com/ada')
    expect(byName('urls[Portfolio]')).toBe('https://ada.example')
    // "Other website" would be a second website: left for the user.
    expect(byName('urls[Other]')).toBe('')
    expect(byName('urls[Twitter]')).toBe('')
    expect((dom.window.document.querySelector('[name="comments"]') as HTMLTextAreaElement).value).toBe('')
    expect(input(dom, 'input[name="resume"]').getAttribute(UPLOAD_ATTR)).toBe('resume')
    expect(field(report, 'Gender').outcome).toBe('skipped-unsupported')
    expect(field(report, 'Will you require visa sponsorship?')).toMatchObject({
      kind: 'radio',
      outcome: 'skipped-unsupported'
    })
    expect(report.fields.filter((f) => f.kind === 'radio')).toHaveLength(1)
    expect(field(report, 'I agree to be contacted about future opportunities.').outcome).toBe('skipped-unsupported')
    expect(input(dom, 'input[name="consent[marketing]"]').checked).toBe(false)
    check()
  })

  it('recognises the thanks page', () => {
    const dom = page('lever-thanks.html', 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001/thanks')
    expect(scanPage(dom.window.document)).toMatchObject({ ats: 'lever', confirmation: true })
    expect(detectConfirmation(page('lever-form.html', URL).window.document)).toBe(false)
  })
})

describe('generic heuristic', () => {
  const URL = 'https://careers.example.com/jobs/42/apply'

  it('never fills or reports a honeypot field, however it is labelled', () => {
    const dom = new JSDOM(
      `<form><label>Email <input name="email"></label><label>Email <input name="email_honeypot"></label>
      <input data-automation-id="beecatcher" type="text"><input class="bot-trap" name="website_url">
      <input type="file" name="resume"></form>`,
      { url: URL }
    )
    const report = fillPage(dom.window.document, VALUES)
    expect(report.fields.map((f) => f.key)).toEqual(['email', 'resume'])
    for (const sel of ['[name="email_honeypot"]', '[data-automation-id="beecatcher"]', '.bot-trap']) {
      expect(input(dom, sel).value, sel).toBe('')
      expect(input(dom, sel).getAttribute('style'), sel).toBeNull()
    }
  })

  it('matches by autocomplete, name and label, and never guesses', () => {
    const dom = page('generic-form.html', URL)
    const check = forbidSubmit(dom)
    const scan = scanPage(dom.window.document)
    expect(scan).toMatchObject({ ats: 'generic', formFound: true, hasResumeInput: true, confirmation: false })
    const report = fillPage(dom.window.document, VALUES)

    // autocomplete="given-name" beats the label "Name".
    expect(field(report, 'Name')).toMatchObject({ key: 'firstName', outcome: 'filled' })
    expect(input(dom, '#f1').value).toBe('Ada')
    expect(field(report, 'Surname')).toMatchObject({ key: 'lastName', outcome: 'filled' })
    expect(field(report, 'Email address')).toMatchObject({ key: 'email', outcome: 'filled' })
    expect(field(report, 'City')).toMatchObject({ key: 'location', outcome: 'filled' })
    expect(field(report, 'LinkedIn profile').outcome).toBe('filled')
    expect(field(report, 'GitHub').outcome).toBe('filled')
    expect(field(report, 'Personal website').outcome).toBe('filled')

    // Two equally likely phone fields: neither is filled.
    const phones = report.fields.filter((f) => f.label === 'Phone')
    expect(phones.map((p) => p.outcome)).toEqual(['ambiguous', 'ambiguous'])
    expect(input(dom, '#p1').value).toBe('')
    // Negatives: not the applicant's current employer / phone.
    expect(field(report, 'Previous employer').outcome).toBe('unmatched')
    expect(input(dom, '#prev').value).toBe('')
    expect(field(report, 'Emergency contact phone').outcome).toBe('unmatched')
    expect(input(dom, '#em').value).toBe('')
    expect(field(report, 'Earliest start date')).toMatchObject({ kind: 'other', outcome: 'unmatched' })
    // Passwords are never reported or touched.
    expect(report.fields.some((f) => f.label.includes('password'))).toBe(false)
    expect(field(report, 'Upload your CV')).toMatchObject({ key: 'resume', outcome: 'to-upload' })
    // A label that contradicts a negative field name: the name wins, the field is left alone.
    expect(field(report, 'Company')).toMatchObject({ key: null, outcome: 'unmatched' })
    expect(input(dom, '[name="previous_employer"]').value).toBe('')
    expect(input(dom, '[name="reference_email"]').value).toBe('')
    expect(report.fields.filter((f) => f.key === 'email').map((f) => f.label)).toEqual(['Email address'])
    // Uploads that did not ask for a resume are never marked.
    expect(field(report, 'Portfolio')).toMatchObject({ key: null, kind: 'file', outcome: 'unmatched' })
    expect(field(report, 'Work sample')).toMatchObject({ key: null, kind: 'file', outcome: 'unmatched' })
    expect(input(dom, '#pf').hasAttribute(UPLOAD_ATTR)).toBe(false)
    expect(input(dom, '#ws').hasAttribute(UPLOAD_ATTR)).toBe(false)
    expect(dom.window.document.querySelectorAll(`[${UPLOAD_ATTR}]`)).toHaveLength(1)
    expect(field(report, 'Gender (optional)').outcome).toBe('skipped-unsupported')
    expect(field(report, 'Are you authorized to work in the country?').outcome).toBe('skipped-unsupported')
    expect(field(report, 'I consent to the processing of my data.').outcome).toBe('skipped-unsupported')
    expect(report.hasSubmitButton).toBe(true)
    check()
  })

  it('never takes a lone unlabelled or portfolio upload for the resume', () => {
    const dom = page('generic-portfolio.html', URL)
    expect(scanPage(dom.window.document)).toMatchObject({ ats: 'generic', formFound: true, hasResumeInput: false })
    const report = fillPage(dom.window.document, VALUES)
    expect(report.fields.find((f) => f.kind === 'file')).toMatchObject({ key: null, outcome: 'unmatched' })
    expect(input(dom, '#upload').hasAttribute(UPLOAD_ATTR)).toBe(false)
  })

  it('rules a field out when its name or placeholder is negative, whatever its label', () => {
    const dom = new JSDOM(
      `<form>
        <label>Company <input name="previous_employer"></label>
        <label>Email <input name="reference_email" autocomplete="email"></label>
        <label>Phone <input name="phone" placeholder="Emergency contact number"></label>
        <label>Email <input name="applicant_email"></label>
        <input type="file" name="resume">
      </form>`,
      { url: URL }
    )
    const report = fillPage(dom.window.document, VALUES)
    expect(report.fields.map((f) => [f.label, f.key, f.outcome])).toEqual([
      ['Company', null, 'unmatched'],
      ['Email', null, 'unmatched'],
      ['Phone', null, 'unmatched'],
      ['Email', 'email', 'filled'],
      ['resume', 'resume', 'to-upload']
    ])
  })

  it('recognises a thank-you page without a form', () => {
    expect(detectConfirmation(page('generic-thanks.html', URL).window.document)).toBe(true)
    expect(detectConfirmation(page('generic-form.html', URL).window.document)).toBe(false)
    const interest = new JSDOM('<h1>Thanks for your interest in Example Co</h1>', { url: URL })
    expect(detectConfirmation(interest.window.document)).toBe(false)
  })

  it('splits identifiers into words', () => {
    expect(identifierWords('applicant[firstName]')).toBe('applicant first name')
    expect(identifierWords('Résumé/CV*')).toBe('résumé cv')
  })
})

describe('setNativeValue', () => {
  function reactLikeInput(type = 'text') {
    const dom = new JSDOM(`<input type="${type}">`)
    const el = dom.window.document.querySelector('input') as HTMLInputElement
    const proto = dom.window.HTMLInputElement.prototype
    const native = Object.getOwnPropertyDescriptor(proto, 'value')!
    const assigned: string[] = []
    // React's value tracker shadows `value` on the element; plain assignments land here and are ignored.
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => native.get!.call(el),
      set: (v: string) => assigned.push(v)
    })
    const events: string[] = []
    for (const t of ['input', 'change', 'blur', 'focusout']) el.addEventListener(t, () => events.push(t))
    return { dom, el, native, assigned, events }
  }

  it('writes through the prototype setter and fires input, change and blur', () => {
    const { el, assigned, events } = reactLikeInput()
    expect(setNativeValue(el, 'Ada')).toBe(true)
    expect(el.value).toBe('Ada')
    expect(assigned).toEqual([])
    expect(events).toEqual(['input', 'change', 'blur', 'focusout'])
  })

  it('reports a value the site throws away', () => {
    const { el, native } = reactLikeInput()
    el.addEventListener('input', () => native.set!.call(el, ''))
    expect(setNativeValue(el, 'not-an-email')).toBe(false)
  })

  it('compares phone numbers by digits after the site reformats them', () => {
    const { el, native } = reactLikeInput('tel')
    el.addEventListener('input', () => native.set!.call(el, '(555) 123-4567'))
    expect(setNativeValue(el, '555.123.4567', true)).toBe(true)
    expect(setNativeValue(el, '555.123.4567', false)).toBe(false)
  })

  it('marks a rejected value in the report', () => {
    const dom = page('generic-form.html', 'https://careers.example.com/apply')
    const email = dom.window.document.querySelector('input[name="contact"]') as HTMLInputElement
    const native = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!
    email.addEventListener('input', () => native.set!.call(email, 'ADA@EXAMPLE'))
    const report = fillPage(dom.window.document, VALUES)
    expect(field(report, 'Email address')).toMatchObject({ outcome: 'rejected' })
    expect(field(report, 'Email address').reason).toContain('ADA@EXAMPLE')
  })
})

describe('application answers (#71)', () => {
  const LEVER = 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001/apply'
  const GENERIC = 'https://careers.example.com/apply'
  const GREENHOUSE = 'https://job-boards.greenhouse.io/acme/jobs/1000001'
  const select = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector) as HTMLSelectElement
  const checked = (dom: JSDOM, name: string) =>
    Array.from(dom.window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .filter((r) => r.name === name && r.checked)
      .map((r) => r.value)
  const facts = (f: PageAnswers['facts']): PageAnswers => ({ facts: f, questions: {} })
  const SPONSOR = 'cards[00000000-0000-4000-8000-0000000000c1][field1]'

  it('chooses a Lever select option and a radio from saved facts, with no click, key or submit', () => {
    const dom = page('lever-form.html', LEVER)
    const check = forbidSubmit(dom)
    const report = fillPage(dom.window.document, VALUES, {
      answers: facts({ gender: 'Female', raceEthnicity: 'decline', needsSponsorship: 'no' })
    })
    expect(field(report, 'Gender')).toMatchObject({
      kind: 'select',
      outcome: 'filled',
      value: 'Female',
      fact: 'gender',
      options: ['Male', 'Female', 'Decline to self-identify'],
      fieldId: 'select:eeo[gender]'
    })
    expect(select(dom, 'select[name="eeo[gender]"]').value).toBe('Female')
    expect(select(dom, 'select[name="eeo[gender]"]').style.outline).toContain('#2f9e44')
    // "decline" picks the page's own decline option.
    expect(field(report, 'Race')).toMatchObject({ outcome: 'filled', value: 'Decline to self-identify' })
    expect(field(report, 'Will you require visa sponsorship?')).toMatchObject({
      kind: 'radio',
      outcome: 'filled',
      value: 'No',
      fact: 'needsSponsorship'
    })
    expect(checked(dom, SPONSOR)).toEqual(['No'])
    // The marketing consent checkbox is never ticked.
    expect(input(dom, 'input[name="consent[marketing]"]').checked).toBe(false)
    check()
  })

  it('answers "authorized to work" and "sponsorship" from a US citizen profile with no prompt', () => {
    const seeded = facts(factsFromProfile('US Citizen'))
    const dom = page('generic-form.html', GENERIC)
    const check = forbidSubmit(dom)
    const report = fillPage(dom.window.document, VALUES, { answers: seeded })
    expect(field(report, 'Are you authorized to work in the country?')).toMatchObject({ outcome: 'filled', value: 'Yes' })
    expect(checked(dom, 'auth')).toEqual(['yes'])
    // Consent, however it is worded, is never ticked; it is not even offered as a question.
    expect(input(dom, 'input[name="consent"]').checked).toBe(false)
    expect(field(report, 'I consent to the processing of my data.').fact).toBeUndefined()
    const lever = page('lever-form.html', LEVER)
    fillPage(lever.window.document, VALUES, { answers: seeded })
    expect(checked(lever, SPONSOR)).toEqual(['No'])
    check()
  })

  it('writes nothing when the saved answer fits none of the options', () => {
    const dom = new JSDOM(
      `<form><label>Email <input name="email" type="email"></label><label for="g">Gender</label>
       <select id="g" name="g"><option value="">Select</option><option>Male</option><option>Female</option></select>
       <input type="file" name="resume"><button type="submit">Send</button></form>`,
      { url: GENERIC }
    )
    const report = fillPage(dom.window.document, VALUES, { answers: facts({ gender: 'decline' }) })
    expect(field(report, 'Gender')).toMatchObject({ outcome: 'skipped-unsupported', fact: 'gender' })
    expect(field(report, 'Gender').reason).toMatch(/not one of this question's options/)
    expect(select(dom, '#g').value).toBe('')
  })

  it('only suggests for a Greenhouse react-select and never changes it', () => {
    const dom = page('greenhouse-form.html', GREENHOUSE)
    const check = forbidSubmit(dom)
    const report = fillPage(dom.window.document, VALUES, { answers: facts({ workAuthorized: 'yes', needsSponsorship: 'no' }) })
    expect(field(report, 'Are you legally authorized to work in the United States?')).toMatchObject({
      kind: 'combobox',
      outcome: 'skipped-unsupported',
      fact: 'workAuthorized',
      suggestion: 'Yes',
      suggestedBy: 'saved'
    })
    expect(
      field(report, 'Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)?')
    ).toMatchObject({ suggestion: 'No', outcome: 'skipped-unsupported' })
    expect(input(dom, '#question_1000007').value).toBe('')
    check()
  })

  it('only suggests for Ashby radios (React radios take a click)', () => {
    const dom = new JSDOM(
      `<div class="ashby-application-form-container"><label for="_systemfield_name">Name</label><input id="_systemfield_name">
       <fieldset><legend>Gender</legend><label><input type="radio" name="eeo_gender" value="m"> Male</label>
       <label><input type="radio" name="eeo_gender" value="d"> Decline to self-identify</label></fieldset></div>`,
      { url: 'https://jobs.ashbyhq.com/acme/00000000-0000-4000-8000-000000000001/application' }
    )
    // Ashby attaches files first; its questions are answered on the text pass.
    const report = fillPage(dom.window.document, VALUES, { text: true, answers: facts({ gender: 'decline' }) })
    expect(field(report, 'Gender')).toMatchObject({
      kind: 'radio',
      outcome: 'skipped-unsupported',
      suggestion: 'Decline to self-identify',
      suggestedBy: 'saved'
    })
    expect(checked(dom, 'eeo_gender')).toEqual([])
  })

  it('suggests on the captured Ashby form, EEO survey included, and never selects', () => {
    const dom = new JSDOM(fixture('ashby-form.html'), { url: 'https://jobs.ashbyhq.com/acme/00000000-0000-4000-8000-000000000001/application' })
    const check = forbidSubmit(dom)
    const report = fillPage(dom.window.document, VALUES, { text: true, answers: facts({ gender: 'Female' }) })
    expect(field(report, 'Gender')).toMatchObject({
      kind: 'radio',
      fact: 'gender',
      outcome: 'skipped-unsupported',
      suggestion: 'Female',
      suggestedBy: 'saved'
    })
    expect(field(report, 'Gender').options).toContain('Female')
    // The resume autofill pane stays out; nothing in the survey is checked.
    expect(report.fields.some((f) => /autofill/i.test(f.label))).toBe(false)
    expect(Array.from(dom.window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).some((r) => r.checked)).toBe(false)
    check()
  })

  it('leaves an inverse age question alone however the saved age fact reads', () => {
    const dom = new JSDOM(
      `<form><label>Email <input name="email" type="email"></label><label for="u">Are you under 18 years of age?</label>
       <select id="u" name="u"><option value="">Select</option><option>Yes</option><option>No</option></select>
       <input type="file" name="resume"><button type="submit">Send</button></form>`,
      { url: GENERIC }
    )
    const report = fillPage(dom.window.document, VALUES, { answers: facts({ over18: 'yes' }) })
    expect(field(report, 'Are you under 18 years of age?')).toMatchObject({ outcome: 'skipped-unsupported' })
    expect(field(report, 'Are you under 18 years of age?').fact).toBeUndefined()
    expect(select(dom, '#u').value).toBe('')
  })

  it('finds a long option again by the name it reported, even when another shares its start', () => {
    const start = 'I am not a protected veteran, and I have read the definitions of every protected veteran category above, '
    const long = `${start}so this applies to me.`
    const other = `${start}but I want to discuss it.`
    const dom = new JSDOM(
      `<form><label>Email <input name="email" type="email"></label><label for="v">Veteran status</label>
       <select id="v" name="v"><option value="">Select</option><option>${other}</option><option>${long}</option></select>
       <input type="file" name="resume"><button type="submit">Send</button></form>`,
      { url: GENERIC }
    )
    const first = fillPage(dom.window.document, VALUES)
    const options = field(first, 'Veteran status').options!
    expect(options).toHaveLength(2)
    expect(options.every((o) => o.length <= 120)).toBe(true)
    expect(new Set(options).size).toBe(2)
    // The panel's pick (the reported name) is written and read back as the exact option.
    const question = field(first, 'Veteran status').question!
    const report = fillPage(dom.window.document, VALUES, {
      answers: { facts: {}, questions: { [question]: { fact: null, value: options[1], confirmed: true } } }
    })
    expect(field(report, 'Veteran status')).toMatchObject({ outcome: 'filled', value: options[1] })
    expect(select(dom, '#v').selectedOptions[0].text).toBe(long)
  })

  it('keeps a choice the page or the user already made', () => {
    const dom = page('lever-form.html', LEVER)
    select(dom, 'select[name="eeo[gender]"]').value = 'Male'
    const report = fillPage(dom.window.document, VALUES, { answers: facts({ gender: 'Female' }) })
    expect(field(report, 'Gender')).toMatchObject({ outcome: 'kept', value: 'Male' })
    expect(select(dom, 'select[name="eeo[gender]"]').value).toBe('Male')
  })

  it('fills a textarea from a remembered question, and fills a typed fact', () => {
    const dom = page('lever-form.html', LEVER)
    const question = questionKey('What interests you about this role?', 'textarea')
    const report = fillPage(dom.window.document, VALUES, {
      answers: { facts: {}, questions: { [question]: { fact: null, value: 'The team.', confirmed: true } } }
    })
    expect(field(report, 'What interests you about this role?')).toMatchObject({ outcome: 'filled', value: 'The team.', question })
    const gh = page('greenhouse-form.html', GREENHOUSE)
    const second = fillPage(gh.window.document, VALUES, { answers: facts({ salaryExpectation: '$150k', noticePeriod: '2 weeks' }) })
    expect(field(second, 'What are your salary expectations?')).toMatchObject({ outcome: 'filled', value: '$150k', fact: 'salaryExpectation' })
    expect(field(second, 'What is your notice period?')).toMatchObject({ outcome: 'filled', value: '2 weeks' })
  })

  it("only suggests a model's mapping until the user confirms it", () => {
    const options = ['Male', 'Female', 'Decline to self-identify']
    const question = questionKey('Gender', 'select', options)
    // The memory's entry wins over the catalog: a mapping only the model made is a suggestion.
    const dom = page('lever-form.html', LEVER)
    const report = fillPage(dom.window.document, VALUES, { answers: { facts: { gender: 'Female' }, questions: { [question]: { fact: 'gender', confirmed: false } } } })
    expect(field(report, 'Gender')).toMatchObject({ outcome: 'skipped-unsupported', suggestion: 'Female', suggestedBy: 'model' })
    expect(select(dom, 'select[name="eeo[gender]"]').value).toBe('')
    const confirmed = page('lever-form.html', LEVER)
    const after = fillPage(confirmed.window.document, VALUES, { answers: { facts: { gender: 'Female' }, questions: { [question]: { fact: 'gender', confirmed: true } } } })
    expect(field(after, 'Gender')).toMatchObject({ outcome: 'filled', value: 'Female' })
  })

  it('restores a saved answer the page wiped after the fill', async () => {
    const dom = page('lever-form.html', LEVER)
    const doc = dom.window.document
    const answers = facts({ gender: 'Female' })
    const report = fillPage(doc, VALUES, { answers })
    select(dom, 'select[name="eeo[gender]"]').value = ''
    await verifyFill(doc, VALUES, report, { settleMs: 1 })
    expect(field(report, 'Gender')).toMatchObject({ outcome: 'filled', value: 'Female' })
    expect(select(dom, 'select[name="eeo[gender]"]').value).toBe('Female')
  })
})

describe('picking remembered answers in click-only widgets (#71, owner decision)', () => {
  const GREENHOUSE = 'https://job-boards.greenhouse.io/acme/jobs/1000001'
  const ASHBY = 'https://jobs.ashbyhq.com/acme/00000000-0000-4000-8000-000000000001/application'
  const WORKDAY = 'https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/Remote-USA/Software-Engineer_JR-1001/apply'
  const REACT_SELECT = readFileSync(join(__dirname, '../../../scripts/mock-ats/sites/react-select.js'), 'utf8')
  const AUTHORIZED = 'Are you legally authorized to work in the United States?'
  const facts = (f: PageAnswers['facts']): PageAnswers => ({ facts: f, questions: {} })

  /** No submit, requestSubmit or key event; pointer and mouse events only. */
  function forbidSubmitAndKeys(dom: JSDOM) {
    const w = dom.window
    const submit = vi.spyOn(w.HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    const requestSubmit = vi.spyOn(w.HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined)
    const events: string[] = []
    for (const type of ['submit', 'keydown', 'keypress', 'keyup']) w.document.addEventListener(type, () => events.push(type), true)
    return () => {
      expect(submit).not.toHaveBeenCalled()
      expect(requestSubmit).not.toHaveBeenCalled()
      expect(events).toEqual([])
    }
  }

  /** The Greenhouse fixture with the mock's react-select behaviour on its authorization question. */
  function greenhouse(): JSDOM {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GREENHOUSE, runScripts: 'outside-only' })
    const container = dom.window.document.getElementById('question_1000007')!.closest('.select__container') as HTMLElement
    container.dataset.mockOptions = 'Yes|No'
    dom.window.eval(REACT_SELECT)
    return dom
  }
  const singleValue = (dom: JSDOM, id: string) =>
    dom.window.document.getElementById(id)!.closest('.select__container')!.querySelector('.select__single-value')?.textContent ?? ''

  it('picks a trusted answer in a Greenhouse react-select and reads it back', async () => {
    const dom = greenhouse()
    const check = forbidSubmitAndKeys(dom)
    const report = fillPage(dom.window.document, VALUES, { answers: facts({ workAuthorized: 'yes' }), pick: true })
    expect(pendingPicks(report)).toHaveLength(1)
    await pickAnswers(report)
    expect(field(report, AUTHORIZED)).toMatchObject({ outcome: 'filled', value: 'Yes', fact: 'workAuthorized' })
    expect(field(report, AUTHORIZED).suggestion).toBeUndefined()
    expect(singleValue(dom, 'question_1000007')).toBe('Yes')
    // The menu closed; nothing else on the page was opened or pressed.
    expect(dom.window.document.querySelector('.select__menu')).toBeNull()
    check()
  })

  it('with the switch off, only suggests (nothing opened, nothing picked)', async () => {
    const dom = greenhouse()
    const report = fillPage(dom.window.document, VALUES, { answers: facts({ workAuthorized: 'yes' }), pick: false })
    expect(pendingPicks(report)).toEqual([])
    expect(field(report, AUTHORIZED)).toMatchObject({ outcome: 'skipped-unsupported', suggestion: 'Yes', suggestedBy: 'saved' })
    expect(dom.window.document.querySelector('.select__menu')).toBeNull()
  })

  it("never picks a model's mapping the user has not confirmed", () => {
    const dom = greenhouse()
    const question = questionKey(AUTHORIZED, 'combobox')
    const report = fillPage(dom.window.document, VALUES, {
      answers: { facts: { workAuthorized: 'yes' }, questions: { [question]: { fact: 'workAuthorized', confirmed: false } } },
      pick: true
    })
    expect(pendingPicks(report)).toEqual([])
    expect(field(report, AUTHORIZED)).toMatchObject({ suggestion: 'Yes', suggestedBy: 'model' })
  })

  it('reports a pick that did not stick as needing the user, with the suggestion', async () => {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GREENHOUSE })
    const report = fillPage(dom.window.document, VALUES, { answers: facts({ workAuthorized: 'yes' }), pick: true })
    // No menu ever opens on the static fixture.
    await pickAnswers(report, pendingPicks(report))
    expect(field(report, AUTHORIZED)).toMatchObject({ outcome: 'rejected', suggestion: 'Yes' })
    expect(field(report, AUTHORIZED).reason).toMatch(/could not pick "Yes".*pick it yourself/)
  })

  it('presses the right Ashby yes/no button and checks the right React radio', async () => {
    const dom = new JSDOM(fixture('ashby-form.html'), { url: ASHBY })
    const doc = dom.window.document
    const check = forbidSubmitAndKeys(dom)
    // Ashby's yes/no buttons: pressing one marks it and sets the hidden checkbox.
    for (const group of Array.from(doc.querySelectorAll('.ashby-application-form-input-yesno'))) {
      for (const button of Array.from(group.querySelectorAll('button'))) {
        button.addEventListener('click', () => {
          for (const b of Array.from(group.querySelectorAll('button'))) b.setAttribute('aria-pressed', String(b === button))
          ;(group.querySelector('input[type="checkbox"]') as HTMLInputElement).checked = button.dataset.option === 'yes'
        })
      }
    }
    const report = fillPage(doc, VALUES, { text: true, answers: facts({ workAuthorized: 'yes', gender: 'decline' }), pick: true })
    await pickAnswers(report)
    const auth = field(report, 'Are you authorized to work in the country where the job is located?')
    expect(auth).toMatchObject({ kind: 'radio', outcome: 'filled', value: 'Yes', options: ['Yes', 'No'] })
    const yes = doc.querySelector('button[data-option="yes"]')!
    expect(yes.getAttribute('aria-pressed')).toBe('true')
    expect((yes.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
    const gender = field(report, 'Gender')
    expect(gender).toMatchObject({ kind: 'radio', outcome: 'filled' })
    const checked = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter((r) => r.checked)
    expect(checked).toHaveLength(1)
    expect(checked[0].labels?.[0]?.textContent).toBe(gender.value)
    // Consent and acknowledgement checkboxes are never ticked.
    expect(Array.from(doc.querySelectorAll<HTMLInputElement>('.ashby-application-form-input-checkbox-group input')).some((c) => c.checked)).toBe(false)
    check()
  })

  it('never presses in a popup that is not tied to the dropdown, and leaves it to the user', async () => {
    const dom = new JSDOM(fixture('workday-my-information.html'), { url: WORKDAY })
    const doc = dom.window.document
    const button = doc.getElementById('source--source')!
    const pressed: string[] = []
    button.addEventListener('click', () => {
      // One popup appears, but nothing ties it to this button: it could be any other widget's.
      doc.body.insertAdjacentHTML('beforeend', '<ul role="listbox"><li role="option" id="stray">LinkedIn</li></ul>')
      doc.getElementById('stray')!.addEventListener('click', () => pressed.push('stray'))
    })
    const first = fillPage(doc, VALUES, { answers: facts({}), pick: true })
    const question = field(first, 'How Did You Hear About Us?').question!
    const report = fillPage(doc, VALUES, {
      answers: { facts: {}, questions: { [question]: { fact: null, value: 'LinkedIn', confirmed: true } } },
      pick: true
    })
    await pickAnswers(report)
    expect(pressed).toEqual([])
    expect(field(report, 'How Did You Hear About Us?')).toMatchObject({ outcome: 'rejected', suggestion: 'LinkedIn' })
    expect(button.textContent).toBe('Select One')
  })

  it('never answers or picks a certification, even when a "Yes" was remembered for it', async () => {
    const dom = new JSDOM(
      `<div class="ashby-application-form-container"><label for="_systemfield_name">Name</label><input id="_systemfield_name">
       <label for="cert">I certify that all information is accurate</label>
       <div class="ashby-application-form-input-yesno"><button data-option="yes" aria-pressed="false">Yes</button>
       <button data-option="no" aria-pressed="false">No</button><input type="checkbox" tabindex="-1" name="cert"></div></div>`,
      { url: ASHBY }
    )
    const doc = dom.window.document
    const question = questionKey('I certify that all information is accurate', 'radio', ['Yes', 'No'])
    const report = fillPage(doc, VALUES, {
      text: true,
      answers: { facts: {}, questions: { [question]: { fact: null, value: 'Yes', confirmed: true } } },
      pick: true
    })
    expect(pendingPicks(report)).toEqual([])
    const line = report.fields.find((f) => f.label === 'I certify that all information is accurate')
    expect(line?.question).toBeUndefined()
    expect(line?.suggestion).toBeUndefined()
    await pickAnswers(report)
    expect((doc.querySelector('input[name="cert"]') as HTMLInputElement).checked).toBe(false)
    expect(doc.querySelector('button[data-option="yes"]')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps a click-only field the person touched or is typing into', async () => {
    const dom = greenhouse()
    const doc = dom.window.document
    watchUserEdits(doc, { isUserEvent: () => true })
    const input = doc.getElementById('question_1000007') as HTMLInputElement
    input.value = 'Ma'
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    const report = fillPage(doc, VALUES, { answers: facts({ workAuthorized: 'yes' }), pick: true })
    expect(pendingPicks(report)).toEqual([])
    expect(field(report, AUTHORIZED)).toMatchObject({ outcome: 'kept', value: 'Ma' })
    expect(input.value).toBe('Ma')
    expect(doc.querySelector('.select__menu')).toBeNull()
  })

  it('reports a picked answer the page wiped afterwards as needing the user, with the suggestion', async () => {
    const dom = new JSDOM(fixture('ashby-form.html'), { url: ASHBY })
    const doc = dom.window.document
    const report = fillPage(doc, VALUES, { text: true, answers: facts({ gender: 'Female' }), pick: true })
    await pickAnswers(report)
    expect(field(report, 'Gender')).toMatchObject({ outcome: 'filled', value: 'Female' })
    // A late re-render clears it before the verify pass.
    for (const r of Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) r.checked = false
    await verifyFill(doc, VALUES, report, { settleMs: 1 })
    expect(field(report, 'Gender')).toMatchObject({ outcome: 'rejected', suggestion: 'Female', suggestedBy: 'saved' })
    expect(field(report, 'Gender').reason).toMatch(/cleared the picked answer "Female"/)
  })

  it('chooses a remembered option in a Workday dropdown (button and popup listbox)', async () => {
    const dom = new JSDOM(fixture('workday-my-information.html'), { url: WORKDAY })
    const doc = dom.window.document
    const check = forbidSubmitAndKeys(dom)
    const button = doc.getElementById('source--source')!
    // Workday renders the options in a popup at the end of <body>; here it names its button (aria-labelledby), the
    // tie pick.ts requires before it presses anything in a popup.
    button.addEventListener('click', () => {
      doc.body.insertAdjacentHTML(
        'beforeend',
        '<div data-automation-id="activeListContainer"><ul role="listbox" aria-labelledby="source--source"><li role="option"><div>Job board</div></li><li role="option"><div>LinkedIn</div></li></ul></div>'
      )
      for (const li of Array.from(doc.querySelectorAll('[role="option"]'))) {
        li.addEventListener('click', () => {
          button.textContent = li.textContent
          doc.querySelector('[data-automation-id="activeListContainer"]')!.remove()
        })
      }
    })
    const first = fillPage(doc, VALUES, { answers: facts({}), pick: true })
    const question = field(first, 'How Did You Hear About Us?').question!
    const report = fillPage(doc, VALUES, {
      answers: { facts: {}, questions: { [question]: { fact: null, value: 'LinkedIn', confirmed: true } } },
      pick: true
    })
    await pickAnswers(report)
    expect(field(report, 'How Did You Hear About Us?')).toMatchObject({ kind: 'combobox', outcome: 'filled', value: 'LinkedIn' })
    expect(button.textContent).toBe('LinkedIn')
    // Other dropdowns, with nothing remembered, were never opened.
    expect(doc.querySelectorAll('[data-automation-id="activeListContainer"]')).toHaveLength(0)
    check()
  })
})
