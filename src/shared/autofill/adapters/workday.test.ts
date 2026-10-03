import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { FieldReport, FillReport, FillValues } from '../../apply-types'
import { UPLOAD_ATTR } from '../../autofill-channels'
import { fillPage, pageStep, scanPage, uploadStateOf } from '../engine'
import { PageSession } from '../session'
import { adapterFor, workday } from './index'

/**
 * The Workday adapter on markup from the 2026-10-03 captures (posting,
 * choice, sign-in and create-account walls) and on the post-sign-in steps
 * rebuilt from open-source Workday autofill code (both tenant variants).
 */

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8')
const JOB = 'https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/Remote-USA/Software-Engineer_JR-1001'
const page = (name: string, url = `${JOB}/apply/applyManually`) => new JSDOM(fixture(name), { url })

const VALUES: FillValues = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 555 123 4567',
  location: 'London',
  linkedin: 'https://www.linkedin.com/in/ada',
  github: 'https://github.com/ada',
  website: 'https://ada.example',
  currentCompany: 'Analytical Engines'
}

const input = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector) as HTMLInputElement
const byKey = (report: FillReport, key: FieldReport['key']) => report.fields.filter((f) => f.key === key)

/** Every value and outline on the page, to prove a fill left it untouched. */
const snapshot = (dom: JSDOM) =>
  Array.from(dom.window.document.querySelectorAll('input, textarea')).map((el) => [
    (el as HTMLInputElement).value,
    el.getAttribute('style'),
    el.getAttribute(UPLOAD_ATTR)
  ])

describe('Workday: recognising the site', () => {
  it('matches Workday hosts and, on other hosts, only Workday apply-flow markup', () => {
    const blank = new JSDOM('<p>hi</p>').window.document
    for (const host of ['acme.wd1.myworkdayjobs.com', 'acme.wd5.myworkdaysite.com', 'wd3.myworkdaysite.com']) {
      expect(workday.matches(new URL(`https://${host}/x`), blank)).toBe(true)
    }
    expect(workday.matches(new URL('https://example.com/careers'), blank)).toBe(false)
    expect(workday.matches(new URL('https://myworkdayjobs.com.evil.example/'), blank)).toBe(false)
    const mock = page('workday-apply-choice.html', 'http://127.0.0.1:4173/workday/job/x/apply')
    expect(adapterFor(new URL(mock.window.location.href), mock.window.document).ats).toBe('workday')
    const greenhouse = page('greenhouse-form.html', 'https://job-boards.greenhouse.io/acme/jobs/1')
    expect(adapterFor(new URL(greenhouse.window.location.href), greenhouse.window.document).ats).toBe('greenhouse')
  })

  it('is ready once the client-rendered app has drawn its page', () => {
    expect(workday.ready?.(new JSDOM('<div id="root"></div>').window.document)).toBe(false)
    expect(workday.ready?.(page('workday-posting.html').window.document)).toBe(true)
  })
})

describe('Workday: step classifier', () => {
  const cases: Array<[string, string, string | null]> = [
    ['workday-posting.html', 'posting', 'Job posting'],
    ['workday-apply-choice.html', 'choice', 'Start Your Application'],
    ['workday-signin.html', 'account-wall', 'Create Account/Sign In'],
    ['workday-create-account.html', 'account-wall', 'Create Account/Sign In'],
    ['workday-my-information.html', 'form', 'My Information'],
    ['workday-my-information-legacy.html', 'form', 'My Information'],
    ['workday-autofill-resume.html', 'form', 'Autofill with Resume'],
    ['workday-my-experience.html', 'form', 'My Experience'],
    ['workday-application-questions.html', 'other', 'Application Questions']
  ]
  for (const [name, step, title] of cases) {
    it(`${name} is ${step} (${title})`, () => {
      const dom = page(name)
      expect(scanPage(dom.window.document)).toMatchObject({ ats: 'workday', step, stepTitle: title, confirmation: false })
      expect(pageStep(dom.window.document)).toMatchObject({ ats: 'workday', step, stepTitle: title, ready: true })
    })
  }

  it('takes the title from the active progress step, not the "current step 2 of 6" counter', () => {
    const dom = page('workday-my-experience.html')
    const active = dom.window.document.querySelector('[data-automation-id="progressBarActiveStep"]')!
    expect(active.textContent).toContain('current step 3 of 6')
    expect(workday.stepTitle?.(dom.window.document)).toBe('My Experience')
  })

  it('treats any page asking for a password as the account wall', () => {
    const dom = page('workday-my-information.html')
    dom.window.document.body.insertAdjacentHTML('beforeend', '<input type="password" id="pw">')
    expect(pageStep(dom.window.document).step).toBe('account-wall')
  })

  it('a Workday page that has not rendered yet is "other", so nothing is filled until it has', () => {
    const dom = new JSDOM('<div id="root"></div>', { url: JOB })
    expect(scanPage(dom.window.document)).toMatchObject({ ats: 'workday', step: 'other', stepTitle: null })
  })
})

describe('Workday: the account wall is never filled', () => {
  for (const name of ['workday-signin.html', 'workday-create-account.html']) {
    it(`${name}: no email, no password, no honeypot, no upload mark, no outline`, () => {
      const dom = page(name)
      const before = snapshot(dom)
      const changes = vi.fn()
      dom.window.document.addEventListener('input', changes, true)
      dom.window.document.addEventListener('change', changes, true)
      const report = fillPage(dom.window.document, VALUES)
      expect(report).toMatchObject({ ats: 'workday', step: 'account-wall', fields: [] })
      expect(snapshot(dom)).toEqual(before)
      expect(changes).not.toHaveBeenCalled()
      for (const sel of ['email', 'password', 'verifyPassword', 'beecatcher']) {
        const el = input(dom, `[data-automation-id="${sel}"]`)
        if (el) expect(el.value, sel).toBe('')
      }
    })
  }

  it('the posting, the choice and other steps are left alone too', () => {
    for (const name of ['workday-posting.html', 'workday-apply-choice.html', 'workday-application-questions.html']) {
      const dom = page(name)
      const before = snapshot(dom)
      const report = fillPage(dom.window.document, VALUES)
      expect(report.fields, name).toEqual([])
      expect(snapshot(dom), name).toEqual(before)
    }
  })
})

describe('Workday: My Information', () => {
  const variants: Array<[string, Record<string, string>]> = [
    [
      'workday-my-information.html',
      {
        firstName: '#name--legalName--firstName',
        lastName: '#name--legalName--lastName',
        email: '#emailAddress--emailAddress',
        phone: '#phoneNumber--phoneNumber',
        location: '#address--city'
      }
    ],
    [
      'workday-my-information-legacy.html',
      {
        firstName: '[data-automation-id="legalNameSection_firstName"]',
        lastName: '[data-automation-id="legalNameSection_lastName"]',
        email: '[data-automation-id="email"]',
        phone: '[data-automation-id="phone-number"]',
        location: '[data-automation-id="addressSection_city"]'
      }
    ]
  ]

  for (const [name, selectors] of variants) {
    it(`${name}: fills first/last name, email, phone and city by data-automation-id and reads them back`, () => {
      const dom = page(name)
      const report = fillPage(dom.window.document, VALUES)
      expect(report.step).toBe('form')
      expect(report.stepTitle).toBe('My Information')
      for (const [key, selector] of Object.entries(selectors)) {
        const lines = byKey(report, key as FieldReport['key'])
        expect(lines, key).toHaveLength(1)
        expect(lines[0]).toMatchObject({ outcome: 'filled', value: VALUES[key as keyof FillValues] })
        expect(input(dom, selector).value, key).toBe(VALUES[key as keyof FillValues])
      }
      expect(report.fields.find((f) => f.key === 'firstName')).toMatchObject({ label: 'First Name', required: true })
    })

    it(`${name}: leaves dropdowns, the phone code picker, the extension and the honeypot alone`, () => {
      const dom = page(name)
      const report = fillPage(dom.window.document, VALUES)
      const labels = report.fields.map((f) => f.label)
      // Workday's dropdowns are buttons, never inputs: they are not even in the report.
      for (const dropdown of ['How Did You Hear About Us?', 'Country', 'Phone Device Type', 'State']) {
        expect(labels).not.toContain(dropdown)
      }
      expect(report.fields.find((f) => f.label === 'Country Phone Code')).toMatchObject({
        kind: 'combobox',
        outcome: 'skipped-unsupported'
      })
      expect(input(dom, '[data-automation-id="beecatcher"]').value).toBe('')
      expect(input(dom, '[data-automation-id="beecatcher"]').getAttribute('style')).toBeNull()
      expect(report.fields.some((f) => /beecatcher/i.test(f.label))).toBe(false)
      expect(byKey(report, 'phone')).toHaveLength(1)
      const extension = input(dom, '#phoneNumber--extension')
      if (extension) expect(extension.value).toBe('')
    })
  }

  it('keeps a value Workday (its resume parser) or the user already put in', () => {
    const dom = page('workday-my-information.html')
    input(dom, '#name--legalName--firstName').value = 'Augusta'
    const report = fillPage(dom.window.document, VALUES)
    expect(byKey(report, 'firstName')[0]).toMatchObject({ outcome: 'kept', value: 'Augusta' })
    expect(byKey(report, 'lastName')[0]).toMatchObject({ outcome: 'filled' })
  })
})

describe('Workday: resume steps', () => {
  it('Autofill with Resume: marks file-upload-input-ref for resume.pdf and nothing else', () => {
    const dom = page('workday-autofill-resume.html', `${JOB}/apply/autofillWithResume`)
    const report = fillPage(dom.window.document, VALUES)
    expect(report.fields.map((f) => [f.key, f.outcome])).toEqual([['resume', 'to-upload']])
    expect(input(dom, '[data-automation-id="file-upload-input-ref"]').getAttribute(UPLOAD_ATTR)).toBe('resume')
  })

  it('My Experience: marks the resume upload and fills the LinkedIn question', () => {
    const dom = page('workday-my-experience.html')
    const report = fillPage(dom.window.document, VALUES)
    expect(byKey(report, 'resume')).toMatchObject([{ outcome: 'to-upload', label: 'Resume/CV' }])
    expect(byKey(report, 'linkedin')).toMatchObject([{ outcome: 'filled', value: VALUES.linkedin }])
    expect(input(dom, '[data-automation-id="linkedinQuestion"]').value).toBe(VALUES.linkedin)
  })

  it('confirms the attach only once Workday lists the file (after its parse)', () => {
    const dom = page('workday-autofill-resume.html', `${JOB}/apply/autofillWithResume`)
    const doc = dom.window.document
    fillPage(doc, VALUES)
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('missing')

    // Workday's widget while it uploads and parses.
    const zone = doc.querySelector('[data-automation-id="file-upload-drop-zone"]')!
    zone.insertAdjacentHTML('beforeend', '<div role="progressbar" aria-label="Uploading"></div>')
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('pending')

    // Then it replaces the drop zone (and its input) with the uploaded-file list.
    zone.outerHTML =
      '<div data-automation-id="file-upload-successful"><div data-automation-id="file-upload-item"><span>resume.pdf</span><button data-automation-id="delete-file">Delete</button></div></div>'
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('attached')
    expect(uploadStateOf(doc, 'resume', 'other.pdf')).toBe('missing')
  })

  it('does not take an older file whose name contains resume.pdf, nor another section’s file, for the attach', () => {
    const dom = page('workday-my-experience.html')
    const doc = dom.window.document
    fillPage(doc, VALUES)
    const item = (name: string) =>
      `<div data-automation-id="file-upload-successful"><div data-automation-id="file-upload-item"><span data-automation-id="file-upload-item-name">${name}</span><button data-automation-id="delete-file">Delete</button></div></div>`
    // An earlier upload in the resume widget whose name merely contains the basename.
    const zone = doc.querySelector('[data-automation-id="file-upload-drop-zone"]')!
    zone.insertAdjacentHTML('beforebegin', item('old-resume.pdf'))
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('missing')
    // resume.pdf listed in another section (Websites) does not confirm the resume widget either.
    doc.querySelector('[data-automation-id="websiteSection"]')!.insertAdjacentHTML('beforeend', item('resume.pdf'))
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('missing')
    // The resume widget replaces its drop zone, input included, with exactly resume.pdf: the group remembered at
    // fill time still finds it.
    zone.outerHTML = item('resume.pdf')
    expect(doc.querySelector('[data-automation-id="file-upload-input-ref"]')).toBeNull()
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('attached')
    expect(uploadStateOf(doc, 'resume', 'RESUME.PDF')).toBe('attached')
  })

  it('is not ready while Workday loads a step or reads the resume', () => {
    const dom = page('workday-my-information.html')
    const doc = dom.window.document
    expect(pageStep(doc)).toMatchObject({ step: 'form', ready: true })
    doc.body.insertAdjacentHTML('beforeend', '<div data-automation-id="resumeParsing" role="status">Reading your resume…</div>')
    expect(pageStep(doc)).toMatchObject({ step: 'form', ready: false })
    expect(scanPage(doc).ready).toBe(false)
  })

  it('lists the step’s profile fields, so a field rendered late changes the step', () => {
    const dom = page('workday-my-information.html')
    const doc = dom.window.document
    const email = doc.querySelector('[data-automation-id="formField-email"]')!
    const html = email.outerHTML
    email.remove()
    expect(pageStep(doc).stepFields).toBe('firstName,lastName,location,phone')
    doc.querySelector('[data-automation-id="formField-phoneType"]')!.insertAdjacentHTML('beforebegin', html)
    expect(pageStep(doc).stepFields).toBe('email,firstName,lastName,location,phone')
    // Single-page adapters report none.
    expect(scanPage(page('greenhouse-form.html', 'https://job-boards.greenhouse.io/acme/jobs/1').window.document).stepFields).toBeNull()
  })
})

describe('Workday: a step re-render after the fill (#63 verify-after-fill)', () => {
  it('writes values a My Information re-render wiped again, in the re-created inputs', async () => {
    const dom = page('workday-my-information.html')
    const doc = dom.window.document
    const session = new PageSession(doc, { verifyAfterMs: 40, settleMs: 0, quietMs: 0, readyMaxMs: 50 })
    const filling = session.fill(VALUES)
    // Workday re-renders the step a moment after the fill: the name fields come back as fresh, empty inputs.
    dom.window.setTimeout(() => {
      for (const id of ['name--legalName--firstName', 'name--legalName--lastName']) {
        const old = doc.getElementById(id) as HTMLInputElement
        const fresh = old.cloneNode() as HTMLInputElement
        fresh.value = ''
        old.replaceWith(fresh)
      }
    }, 10)
    const report = await filling
    expect(input(dom, '#name--legalName--firstName').value).toBe('Ada')
    expect(input(dom, '#name--legalName--lastName').value).toBe('Lovelace')
    expect(byKey(report, 'firstName')[0]).toMatchObject({ outcome: 'filled', value: 'Ada' })
    expect(byKey(report, 'lastName')[0]).toMatchObject({ outcome: 'filled' })
    // Untouched fields stayed as filled.
    expect(input(dom, '#emailAddress--emailAddress').value).toBe('ada@example.com')
  })

  it('reports a value the step keeps clearing as rejected, not filled', async () => {
    const dom = page('workday-my-information-legacy.html')
    const doc = dom.window.document
    const session = new PageSession(doc, { verifyAfterMs: 20, settleMs: 30, quietMs: 0, readyMaxMs: 50 })
    const city = input(dom, '[data-automation-id="addressSection_city"]')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    const filling = session.fill(VALUES)
    // After the first fill, every write to City is thrown away again by the page.
    dom.window.setTimeout(() => {
      setter.call(city, '')
      city.addEventListener('input', () => dom.window.setTimeout(() => setter.call(city, ''), 5))
    }, 5)
    const report = await filling
    expect(city.value).toBe('')
    expect(byKey(report, 'location')[0]).toMatchObject({ outcome: 'rejected' })
    expect(byKey(report, 'firstName')[0]).toMatchObject({ outcome: 'filled' })
  })
})
