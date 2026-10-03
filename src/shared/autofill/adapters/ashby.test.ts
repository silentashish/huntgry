import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { FillReport, FillValues } from '../../apply-types'
import { UPLOAD_ATTR } from '../../autofill-channels'
import { detectConfirmation, fillPage, scanPage } from '../engine'
import { ashby, ashbyUploadState } from './ashby'
import { adapterFor } from './index'

/** Ashby on the form captured from a live page (fixtures/ashby-form.html, 2026-10-03). */

const URL = 'https://jobs.ashbyhq.com/acme/0f3c1f5a-1111-4222-8333-944445555666/application'
const FORM = readFileSync(join(__dirname, '../fixtures/ashby-form.html'), 'utf8')
const LINKEDIN = '#a5b0ffff-0000-4000-8000-00000000ffff'

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

const page = (html = FORM, url = URL) => new JSDOM(html, { url })
const $ = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector) as HTMLInputElement
const byKey = (report: FillReport, key: string) => report.fields.find((f) => f.key === key)

/** Fails the test if anything submits, clicks or presses a key on the page. */
function forbidSubmit(dom: JSDOM) {
  const w = dom.window
  const click = vi.spyOn(w.HTMLElement.prototype, 'click')
  const events: string[] = []
  for (const type of ['submit', 'click', 'keydown', 'keypress', 'mousedown']) {
    w.document.addEventListener(type, () => events.push(type), true)
  }
  return () => {
    expect(click).not.toHaveBeenCalled()
    expect(events).toEqual([])
  }
}

/** Ashby's file widget after an upload (class names from Ashby's bundle): the item, its name, the delete button. */
function attachInWidget(dom: JSDOM, name: string, uploading = false) {
  const doc = dom.window.document
  const widget = doc.getElementById('_systemfield_resume')!.closest('.ashby-application-form-input-file')!
  const item = doc.createElement('div')
  item.className = '_file_10xk4 ashby-application-form-input-file-item'
  item.innerHTML =
    `<div class="ashby-application-form-input-file-item-name"><p><span>${name}</span></p></div>` +
    (uploading ? '' : '<div class="ashby-application-form-input-file-item-delete"><button title="Delete file"></button></div>')
  widget.querySelector('.ashby-application-form-input-file-dropzone')!.before(item)
  return widget
}

describe('Ashby adapter', () => {
  it('recognises Ashby by host, and by its markup on another host (mocks, custom domains)', () => {
    const shell = page('<div id="root"></div>')
    expect(adapterFor(new globalThis.URL(URL), shell.window.document).ats).toBe('ashby')
    const elsewhere = page(FORM, 'http://127.0.0.1:4173/ashby/')
    expect(scanPage(elsewhere.window.document).ats).toBe('ashby')
    expect(scanPage(page(FORM, 'https://careers.example.com/apply').window.document).ats).toBe('ashby')
    // A page that merely mentions Ashby is not Ashby.
    expect(scanPage(page('<form><input name="email"><input type="file" name="resume"></form>', 'https://x.example').window.document).ats).toBe(
      'generic'
    )
  })

  it('is not ready (and has no form) until the client-rendered form exists', () => {
    const shell = page('<!DOCTYPE html><title>Software Engineer @ Acme</title><div id="root"></div>')
    expect(ashby.ready!(shell.window.document)).toBe(false)
    expect(scanPage(shell.window.document)).toMatchObject({ ats: 'ashby', formFound: false, hasResumeInput: false })
    // The autofill pane alone (it renders first on slow pages) is not the form.
    const pane = page(`<div id="form">${FORM.match(/<div class="_autofillPane[\s\S]*?<\/div><\/div><\/div><\/div>/)![0]}</div>`)
    expect(ashby.ready!(pane.window.document)).toBe(false)
    expect(scanPage(pane.window.document).formFound).toBe(false)

    const dom = page()
    expect(ashby.ready!(dom.window.document)).toBe(true)
    expect(scanPage(dom.window.document)).toMatchObject({
      ats: 'ashby',
      formFound: true,
      hasResumeInput: true,
      confirmation: false,
      embedUrl: null,
      step: 'form'
    })
  })

  it('fills legal name, email, phone and LinkedIn, and marks only #_systemfield_resume for upload', () => {
    const dom = page()
    const ok = forbidSubmit(dom)
    // files-first: the first pass only marks the resume; main uploads it, then asks for the text.
    const files = fillPage(dom.window.document, VALUES)
    expect(files.uploadOrder).toBe('files-first')
    expect(files.fields.filter((f) => f.key).map((f) => [f.key, f.outcome])).toEqual([['resume', 'to-upload']])
    expect(files.fields.some((f) => f.outcome === 'filled')).toBe(false)
    expect($(dom, '#_systemfield_name').value).toBe('')
    const report = fillPage(dom.window.document, VALUES, { text: true })
    ok()
    expect(report.ats).toBe('ashby')
    expect($(dom, '#_systemfield_name').value).toBe('Ada Lovelace')
    expect($(dom, '#_systemfield_email').value).toBe('ada@example.com')
    expect($(dom, 'input[type="tel"]').value).toBe('+1 555 123 4567')
    expect($(dom, LINKEDIN).value).toBe('https://www.linkedin.com/in/ada')
    for (const key of ['fullName', 'email', 'phone', 'linkedin']) expect(byKey(report, key)?.outcome, key).toBe('filled')
    expect(byKey(report, 'fullName')?.label).toBe('Legal Name')
    expect(byKey(report, 'phone')?.label).toBe('Phone Number')

    // The real resume field is marked; the "Autofill from resume" parser input is outside the form and untouched.
    const marked = Array.from(dom.window.document.querySelectorAll(`[${UPLOAD_ATTR}]`))
    expect(marked.map((el) => el.id)).toEqual(['_systemfield_resume'])
    expect(byKey(report, 'resume')).toMatchObject({ outcome: 'to-upload', kind: 'file', label: 'Resume', required: true })
    expect(report.fields.filter((f) => f.kind === 'file')).toHaveLength(1)
    expect($(dom, '.ashby-application-form-autofill-uploader input[type="file"]').style.outline).toBe('')
  })

  it('leaves preferred name, the location picker, the date picker and every choice to the user', () => {
    const dom = page()
    const report = fillPage(dom.window.document, VALUES, { text: true })
    expect($(dom, '#a5b00002-0000-4000-8000-000000000002').value).toBe('')
    expect(report.fields.find((f) => f.label.startsWith('Preferred Name'))?.outcome).toBe('unmatched')
    // "Where are you currently located?" is an autocomplete combobox: never typed into.
    expect($(dom, '.ashby-application-form-input-autocomplete').value).toBe('')
    expect(report.fields.find((f) => f.kind === 'combobox')?.outcome).toBe('skipped-unsupported')
    expect($(dom, '.ashby-application-form-input-date').value).toBe('')
    for (const f of report.fields.filter((x) => x.kind === 'checkbox' || x.kind === 'radio')) expect(f.outcome).toBe('skipped-unsupported')
    expect(report.fields.some((f) => f.key === 'location')).toBe(false)
    // The adapter names the pickers so the engine can report them as choices.
    const doc = dom.window.document
    for (const selector of ashby.choices!) expect(doc.querySelector(selector), selector).not.toBeNull()
  })

  it('keeps values that are already there (Ashby’s autofill parser or the user)', () => {
    const dom = page()
    $(dom, '#_systemfield_name').value = 'Augusta Ada King'
    $(dom, LINKEDIN).value = 'https://linkedin.com/in/ada-king'
    const report = fillPage(dom.window.document, VALUES, { text: true })
    expect($(dom, '#_systemfield_name').value).toBe('Augusta Ada King')
    expect($(dom, LINKEDIN).value).toBe('https://linkedin.com/in/ada-king')
    expect(byKey(report, 'fullName')).toMatchObject({ outcome: 'kept', value: 'Augusta Ada King' })
    expect(byKey(report, 'linkedin')?.outcome).toBe('kept')
    // Empty ones are still filled.
    expect(byKey(report, 'email')?.outcome).toBe('filled')
  })

  it('reads the upload state from Ashby’s widget: missing, then pending while it uploads, then attached', () => {
    const dom = page()
    const doc = dom.window.document
    const input = $(dom, '#_systemfield_resume')
    const group = ashby.uploadGroup!(input)
    expect(group?.classList.contains('ashby-application-form-input-file')).toBe(true)
    const probe = { doc, kind: 'resume' as const, input, group, fileName: 'resume.pdf' }
    expect(ashbyUploadState(probe)).toBe('missing')
    // A file in the input alone is not an upload: Ashby has not taken it yet.
    expect(ashby.uploadAttached!(probe)).toBe('missing')

    const item = attachInWidget(dom, 'resume.pdf', true).querySelector('.ashby-application-form-input-file-item')!
    expect(ashby.uploadAttached!(probe)).toBe('pending')
    expect(doc.querySelector(ashby.afterUpload!.waitFor)).toBeNull()
    item.remove()
    attachInWidget(dom, 'resume.pdf')
    expect(ashby.uploadAttached!(probe)).toBe('attached')
    expect(doc.querySelector(ashby.afterUpload!.waitFor)).not.toBeNull()
    // Another file in the widget is not ours.
    expect(ashby.uploadAttached!({ ...probe, fileName: 'cv-old.pdf' })).toBe('missing')
    // Found again when the group was re-rendered (detached) or not remembered.
    expect(ashby.uploadAttached!({ ...probe, group: null })).toBe('attached')
    expect(ashby.uploadAttached!({ ...probe, group: doc.createElement('div') })).toBe('attached')
  })

  it('detects the success panel, not the failure one', () => {
    const success = page(
      '<div class="ashby-application-form-success-container"><div role="status"><h2>Success</h2><p>Your application was successfully submitted. We\'ll contact you if there are next steps.</p></div></div>'
    )
    expect(detectConfirmation(success.window.document)).toBe(true)
    const failure = page(
      `${FORM}<div class="ashby-application-form-failure-container"><div role="alert"><h2>We couldn't submit your application</h2></div></div>`
    )
    expect(detectConfirmation(failure.window.document)).toBe(false)
    expect(detectConfirmation(page().window.document)).toBe(false)
  })
})
