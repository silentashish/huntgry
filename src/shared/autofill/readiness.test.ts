import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import type { FieldReport, FillReport, FillValues } from '../apply-types'
import { UPLOAD_ATTR, UPLOAD_GROUP_ATTR } from '../autofill-channels'
import { ADAPTERS, type Adapter } from './adapters'
import { fillPage, scanPage, uploadStateOf, verifyFill } from './engine'
import { anyShown, waitForReady } from './ready'

/**
 * #63: the page is filled only once it is ready, every value is verified a
 * moment later (React hydration resets server-rendered forms), and an upload
 * counts only when the site's own widget shows the file.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const GH = 'https://job-boards.greenhouse.io/acme/jobs/1000001'
const LEVER = 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001/apply'

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

const byKey = (report: FillReport, key: FieldReport['key']) => report.fields.find((f) => f.key === key)
const input = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector) as HTMLInputElement

/** What React hydration does to server-rendered inputs: values back to the server's (empty), file inputs re-created. */
function hydrate(dom: JSDOM): void {
  const doc = dom.window.document
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  for (const el of Array.from(doc.querySelectorAll('input:not([type="file"])'))) setter.call(el, '')
  for (const el of Array.from(doc.querySelectorAll('input[type="file"]'))) {
    const fresh = doc.createElement('input')
    for (const attr of ['id', 'class', 'type', 'accept']) {
      const value = el.getAttribute(attr)
      if (value !== null) fresh.setAttribute(attr, value)
    }
    el.replaceWith(fresh)
  }
}

describe('verifyFill (hydration reset)', () => {
  it('writes wiped values again and marks re-created file inputs', () => {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GH })
    const doc = dom.window.document
    const report = fillPage(doc, VALUES)
    expect(byKey(report, 'firstName')?.outcome).toBe('filled')
    hydrate(dom)
    // Without the verify pass the page is empty while the report still says "filled" (the #63 bug).
    expect(input(dom, '#first_name').value).toBe('')
    expect(doc.querySelector(`[${UPLOAD_ATTR}="resume"]`)).toBeNull()

    verifyFill(doc, VALUES, report)
    for (const [selector, value] of [
      ['#first_name', 'Ada'],
      ['#last_name', 'Lovelace'],
      ['#email', 'ada@example.com'],
      ['#phone', '+1 555 123 4567'],
      ['#question_1000008', 'https://www.linkedin.com/in/ada']
    ]) {
      expect(input(dom, selector).value, selector).toBe(value)
    }
    for (const key of ['firstName', 'lastName', 'email', 'phone', 'linkedin'] as const) {
      expect(byKey(report, key)?.outcome, key).toBe('filled')
    }
    expect(input(dom, '#resume').getAttribute(UPLOAD_ATTR)).toBe('resume')
    expect(input(dom, '#cover_letter').getAttribute(UPLOAD_ATTR)).toBe('cover')
  })

  it('reports a value the page keeps clearing as rejected, not filled', () => {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GH })
    const doc = dom.window.document
    const report = fillPage(doc, VALUES)
    const email = input(dom, '#email')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(email, '')
    email.addEventListener('input', () => setter.call(email, ''))
    verifyFill(doc, VALUES, report)
    expect(byKey(report, 'email')).toMatchObject({ outcome: 'rejected', reason: 'The page cleared it after filling; fill it in.' })
    expect(byKey(report, 'firstName')?.outcome).toBe('filled')
  })

  it('restores a value a resume parser replaced', () => {
    const dom = new JSDOM(fixture('lever-form.html'), { url: LEVER })
    const doc = dom.window.document
    const report = fillPage(doc, VALUES)
    input(dom, 'input[name="name"]').value = 'Parsed Name'
    verifyFill(doc, VALUES, report)
    expect(input(dom, 'input[name="name"]').value).toBe('Ada Lovelace')
    expect(byKey(report, 'fullName')?.outcome).toBe('filled')
  })

  it('leaves the report alone once the page is another page', () => {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GH })
    const report = fillPage(dom.window.document, VALUES)
    const other = new JSDOM(fixture('greenhouse-form.html'), { url: `${GH}/confirmation` })
    expect(verifyFill(other.window.document, VALUES, report).fields).toEqual(report.fields)
  })
})

describe('upload state (the site widget, not just the input)', () => {
  it('Greenhouse: the input is replaced by a progress bar, then by the file name', () => {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GH })
    const doc = dom.window.document
    fillPage(doc, VALUES)
    const group = doc.querySelector(`[${UPLOAD_GROUP_ATTR}="resume"]`)!
    expect(group.getAttribute('aria-labelledby')).toBe('upload-label-resume')
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('missing')

    const wrapper = group.querySelector('.file-upload__wrapper')!
    wrapper.innerHTML = '<div class="file-upload__progressbar" role="progressbar" aria-valuenow="40"></div>'
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('pending')
    wrapper.innerHTML = '<div class="file-upload__filename">resume.pdf</div><button type="button">Remove file</button>'
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('attached')
    expect(uploadStateOf(doc, 'resume', 'other.pdf')).toBe('missing')
  })

  it('Greenhouse: finds the widget by its label even when the re-render replaced it', () => {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GH })
    const doc = dom.window.document
    fillPage(doc, VALUES)
    const group = doc.querySelector(`[${UPLOAD_GROUP_ATTR}="cover"]`)!
    const fresh = doc.createElement('div')
    fresh.setAttribute('role', 'group')
    fresh.setAttribute('aria-labelledby', 'upload-label-cover_letter')
    fresh.textContent = 'cover.pdf'
    group.replaceWith(fresh)
    expect(uploadStateOf(doc, 'coverLetter', 'cover.pdf')).toBe('attached')
  })

  it('Lever: the file name in the widget, and "Analyzing resume..." while the parser runs', () => {
    const dom = new JSDOM(fixture('lever-form.html'), { url: LEVER })
    const doc = dom.window.document
    fillPage(doc, VALUES)
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('missing')
    ;(doc.querySelector('.resume-upload-working') as HTMLElement).style.display = 'inline'
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('pending')
    doc.querySelector('.filename')!.textContent = 'resume.pdf'
    expect(uploadStateOf(doc, 'resume', 'resume.pdf')).toBe('attached')
  })

  it('Lever waits for the parser to finish before verifying', () => {
    const lever = ADAPTERS.find((a) => a.ats === 'lever')!
    expect(lever.afterUpload).toEqual({ waitFor: '.resume-upload-success, .resume-upload-failure', timeoutMs: 10_000 })
    const dom = new JSDOM(fixture('lever-form.html'), { url: LEVER })
    const doc = dom.window.document
    // The labels are always in the markup; only the shown one counts.
    expect(doc.querySelector('.resume-upload-success')).not.toBeNull()
    expect(anyShown(doc, lever.afterUpload!.waitFor)).toBe(false)
    ;(doc.querySelector('.resume-upload-success') as HTMLElement).style.display = 'inline'
    expect(anyShown(doc, lever.afterUpload!.waitFor)).toBe(true)
  })
})

describe('waitForReady', () => {
  it('waits for the DOM to stop changing', async () => {
    const dom = new JSDOM('<form><input id="a"></form>', { url: GH, pretendToBeVisual: true })
    const doc = dom.window.document
    let changes = 0
    const timer = dom.window.setInterval(() => {
      if (++changes > 5) return dom.window.clearInterval(timer)
      doc.body.append(doc.createElement('span'))
    }, 40)
    const started = Date.now()
    expect(await waitForReady(doc, () => ADAPTERS.at(-1)!, { quietMs: 150, maxMs: 3000 })).toBe(true)
    expect(changes).toBeGreaterThan(5)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150 + 5 * 40 - 20)
  })

  it("then for the adapter's ready hook, and gives up at the cap", async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: GH })
    const doc = dom.window.document
    const lateForm: Adapter = { ...ADAPTERS.at(-1)!, ready: (d) => d.querySelector('#name') !== null }
    dom.window.setTimeout(() => (doc.getElementById('root')!.innerHTML = '<input id="name">'), 300)
    expect(await waitForReady(doc, () => lateForm, { quietMs: 50, maxMs: 3000 })).toBe(true)
    expect(doc.querySelector('#name')).not.toBeNull()
    const never: Adapter = { ...lateForm, ready: async () => false }
    expect(await waitForReady(doc, () => never, { quietMs: 50, maxMs: 400 })).toBe(false)
  })
})

describe('adapter hooks', () => {
  const registry = ADAPTERS as Adapter[]
  afterEach(() => {
    const at = registry.findIndex((a) => a.ats === 'workday')
    if (at >= 0) registry.splice(at, 1)
  })
  const withAdapter = (adapter: Partial<Adapter>) =>
    registry.unshift({ ...registry.at(-1)!, ats: 'workday', matches: () => true, ...adapter })

  it('fills nothing on a step that is not a form (e.g. a sign-in wall)', () => {
    withAdapter({ step: () => 'account-wall', stepTitle: () => ' Sign In ' })
    const dom = new JSDOM(
      '<form><input name="email" type="text" autocomplete="email"><input name="password" type="password"></form>',
      { url: 'https://acme.wd5.myworkdayjobs.com/x/job/1/apply' }
    )
    const doc = dom.window.document
    expect(scanPage(doc)).toMatchObject({ ats: 'workday', step: 'account-wall', stepTitle: 'Sign In' })
    expect(fillPage(doc, VALUES).fields).toEqual([])
    expect(input(dom, 'input[name="email"]').value).toBe('')
  })

  it('files-first: the first pass marks uploads only, the second fills text', () => {
    withAdapter({ uploadOrder: 'files-first' })
    const dom = new JSDOM('<form><input name="email" autocomplete="email"><input type="file" name="resume"></form>', {
      url: 'https://acme.example/apply'
    })
    const doc = dom.window.document
    const first = fillPage(doc, VALUES)
    expect(first.uploadOrder).toBe('files-first')
    expect(first.fields.map((f) => [f.key, f.outcome])).toEqual([['resume', 'to-upload']])
    expect(input(dom, 'input[name="email"]').value).toBe('')
    const second = fillPage(doc, VALUES, { text: true })
    expect(second.fields.map((f) => [f.key, f.outcome])).toEqual([
      ['email', 'filled'],
      ['resume', 'to-upload']
    ])
  })

  it('choices: an adapter can turn a text input into a pick-it-yourself field', () => {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GH })
    const report = fillPage(dom.window.document, VALUES)
    expect(report.fields.find((f) => f.label === 'Location (City)')).toMatchObject({ outcome: 'skipped-unsupported' })
    expect(input(dom, '#candidate-location').value).toBe('')
  })
})
