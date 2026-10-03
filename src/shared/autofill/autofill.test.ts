import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { FieldReport, FillReport, FillValues } from '../apply-types'
import { UPLOAD_ATTR } from '../autofill-channels'
import { setNativeValue } from './dom'
import { detectConfirmation, fillPage, scanPage } from './engine'
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
