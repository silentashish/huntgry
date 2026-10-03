import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { withFakeAgents } from '../fixtures/fake-agent'
import { expect, test, type MockServer } from '../fixtures/servers/fixture'
import { clickLinkInTab, evaluateInTab, expectInTab, expectTabLoaded, listTabs, pressSubmitInTab } from '../fixtures/tabs'
import { BrowserPage } from '../pages/browser'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'

/**
 * #63: Apply on a GENERATED resume reaches the application form, attaches that
 * application's own resume.pdf so the site's upload widget shows it, and fills
 * the contact fields, against mocks that behave like the live sites
 * (scripts/mock-ats/sites): Greenhouse hydrates after `load` and resets
 * anything filled before it, then uploads a chosen file to its "S3" and swaps
 * the input for the file name; Lever runs its résumé parser on the file.
 *
 * Huntgry never submits: the ONLY Submit press, and the only click on a
 * site's own "Apply now" link, is the test's (`pressSubmitInTab`,
 * `clickLinkInTab`). The mock records uploads (`uploads.json`, with sha256)
 * and the test-submitted payload (`last-submission.json`).
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents({ script: 'normal' }) })

const PROFILE = {
  first: 'Alex',
  last: 'Rivera',
  full: 'Alex Rivera',
  email: 'alex.rivera@example.com',
  phone: '(555) 010-0199',
  linkedin: 'https://www.linkedin.com/in/alex-rivera-example/',
  github: 'https://github.com/alex-rivera-example'
}

const exists = (path: string) => access(path).then(() => true, () => false)
const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')

interface Upload {
  site: string
  field?: string
  file: string
  bytes: number
  sha256: string
}
const uploads = async (mock: MockServer): Promise<Upload[]> =>
  JSON.parse(await readFile(mock.uploadsFile, 'utf8').catch(() => '[]'))

const value = (selector: string) => `document.querySelector(${JSON.stringify(selector)})?.value ?? null`

/** The Greenhouse form holds the profile and its upload widget shows resume.pdf (the input itself is gone). */
async function expectGreenhouseFilled(app: { electronApp: Parameters<typeof evaluateInTab>[0] }, urlPart: string) {
  // Hydration has run (the mock resets values ~300 ms after load), and the values survived it.
  await expectInTab(app.electronApp, urlPart, 'document.documentElement.dataset.hydrated', 'true')
  await expectInTab(
    app.electronApp,
    urlPart,
    `document.querySelector('[aria-labelledby="upload-label-resume"]').textContent.includes('resume.pdf')`,
    true
  )
  expect(await evaluateInTab(app.electronApp, urlPart, `document.querySelector('#resume') === null`)).toBe(true)
  for (const [selector, expected] of [
    ['#first_name', PROFILE.first],
    ['#last_name', PROFILE.last],
    ['#email', PROFILE.email],
    ['#phone', PROFILE.phone],
    ['#question_1000008', PROFILE.linkedin]
  ]) {
    expect(await evaluateInTab(app.electronApp, urlPart, value(selector)), selector).toBe(expected)
  }
}

/** Starts Apply from a Dashboard row and waits for the Browser page. */
async function applyFromDashboard(page: Page, company: string): Promise<BrowserPage> {
  const shell = new Shell(page)
  await shell.goTo('dashboard')
  await page.getByRole('row').filter({ hasText: company }).getByRole('button', { name: 'Apply', exact: true }).click()
  await shell.expectActive('browser')
  return new BrowserPage(page)
}

test.describe('apply with the generated resume', () => {
  test('Tailor run → Apply: the Greenhouse form is filled after hydration, the run’s own resume.pdf is attached', async ({
    app,
    mock
  }) => {
    const folder = 'platform-engineer/hydrate-co/gh-63'
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await tailor.start({
      jobUrl: `${mock.origin}/greenhouse/`,
      description: '# Platform Engineer\n\nHydrate Co is hiring a Platform Engineer. Go, PostgreSQL.',
      company: 'Hydrate Co',
      role: 'Platform Engineer',
      jobId: 'GH-63'
    })
    await tailor.expectStatus('Waiting for you')
    await tailor.reply('Approved')
    await expect(tailor.outputLine(folder)).toBeVisible()
    await expect(tailor.outputButton('Apply')).toBeEnabled()
    await expect(tailor.applyReason).toHaveCount(0)

    await tailor.outputButton('Apply').click()
    await new Shell(app.window).expectActive('browser')
    const browser = new BrowserPage(app.window)
    await expectTabLoaded(app.electronApp, '/greenhouse/', 'Job Application for Software Engineer at Acme')
    await browser.apply.expectStatus('Filled: review and submit')
    await expect(app.window.getByText('Platform Engineer · Hydrate Co')).toBeVisible()
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')

    await expectGreenhouseFilled(app, '/greenhouse/')
    // The file the site received is exactly this run's resume.pdf.
    const [upload] = (await uploads(mock)).filter((u) => u.site === 'greenhouse')
    expect(upload).toMatchObject({ field: 'resume', file: 'resume.pdf' })
    expect(upload.sha256).toBe(await sha256(join(app.workspace!, folder, 'resume.pdf')))
    expect(await exists(mock.submissionFile)).toBe(false)

    // The test presses the site's Submit; the payload carries the names and the uploaded resume.
    await pressSubmitInTab(app.electronApp, '/greenhouse/')
    await expectTabLoaded(app.electronApp, '/greenhouse/confirmation', 'Acme')
    const submission = JSON.parse(await readFile(mock.submissionFile, 'utf8'))
    expect(submission.fields).toMatchObject({
      first_name: PROFILE.first,
      last_name: PROFILE.last,
      email: PROFILE.email,
      phone: PROFILE.phone,
      question_1000008: PROFILE.linkedin,
      resume: { file: 'resume.pdf', bytes: upload.bytes }
    })
    await browser.apply.expectStatus('Submitted')
  })

  test('Dashboard row → Apply on Lever: attached through the résumé parser, contact values kept', async ({ app, mock }) => {
    const browser = await applyFromDashboard(app.window, 'Lever Mock')
    await expectTabLoaded(app.electronApp, '/lever/', 'Acme - Software Engineer')
    await browser.apply.expectStatus('Filled: review and submit')
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')

    // The widget shows the file and the parser ran; it did not replace what Huntgry filled.
    await expectInTab(app.electronApp, '/lever/', `document.querySelector('.filename').textContent`, 'resume.pdf')
    await expectInTab(app.electronApp, '/lever/', `getComputedStyle(document.querySelector('.resume-upload-success')).display`, 'inline-block')
    for (const [selector, expected] of [
      ['input[name="name"]', PROFILE.full],
      ['input[name="email"]', PROFILE.email],
      ['input[name="phone"]', PROFILE.phone],
      ['input[name="urls[LinkedIn]"]', PROFILE.linkedin],
      ['input[name="urls[GitHub]"]', PROFILE.github]
    ]) {
      expect(await evaluateInTab(app.electronApp, '/lever/', value(selector)), selector).toBe(expected)
    }
    const [upload] = (await uploads(mock)).filter((u) => u.site === 'lever')
    expect(upload).toMatchObject({ file: 'resume.pdf' })
    expect(upload.sha256).toBe(await sha256(join(app.workspace!, 'software-engineer/lever-mock/lv-1/resume.pdf')))

    await pressSubmitInTab(app.electronApp, '/lever/', {
      'textarea[required]': 'Yes, remote from Portland.',
      'input[name="location"]': 'Portland, OR'
    })
    await expectTabLoaded(app.electronApp, '/lever/thanks', 'Acme')
    const submission = JSON.parse(await readFile(mock.submissionFile, 'utf8'))
    expect(submission.fields).toMatchObject({
      name: PROFILE.full,
      email: PROFILE.email,
      phone: PROFILE.phone,
      'urls[LinkedIn]': PROFILE.linkedin,
      resume: { file: 'resume.pdf', bytes: upload.bytes }
    })
  })

  test('drawer → "Apply in browser" on Greenhouse fills and attaches the same way', async ({ app, mock }) => {
    await new Shell(app.window).goTo('dashboard')
    await app.window.getByRole('row').filter({ hasText: 'Greenhouse Mock' }).getByText('Greenhouse Mock').click()
    await app.window.getByRole('dialog').getByRole('button', { name: 'Apply in browser' }).click()
    await new Shell(app.window).expectActive('browser')
    const browser = new BrowserPage(app.window)
    await browser.apply.expectStatus('Filled: review and submit')
    await expectGreenhouseFilled(app, '/greenhouse/')
    const [upload] = await uploads(mock)
    expect(upload.sha256).toBe(await sha256(join(app.workspace!, 'software-engineer/greenhouse-mock/gh-1/resume.pdf')))
  })

  test('a Greenhouse board that redirects to the company site: the late validityToken embed is opened and filled', async ({
    app,
    mock
  }) => {
    const browser = await applyFromDashboard(app.window, 'Company Embed Mock')
    // The company page on the other origin injects the iframe 800 ms after load; Huntgry opens it in the tab.
    await expect
      .poll(async () => (await listTabs(app.electronApp)).map((t) => t.url.replace(/^https?:\/\/[^/]+|\?.*$/g, '')))
      .toEqual(['/embed/job_app'])
    await browser.apply.expectStatus('Filled: review and submit')
    await expectGreenhouseFilled(app, '/embed/job_app')
    expect(mock.requests.some((r) => r.startsWith('/company/careers?gh_jid=1000001'))).toBe(true)
    expect((await uploads(mock)).map((u) => u.file)).toEqual(['resume.pdf'])
    expect(await exists(mock.submissionFile)).toBe(false)
  })

  test('a posting whose Apply opens a new tab: the session follows the form there', async ({ app, mock }) => {
    const browser = await applyFromDashboard(app.window, 'Popup Mock')
    await expectTabLoaded(app.electronApp, '/company/posting-popup', 'Software Engineer - Acme')
    await browser.apply.expectStatus('Ready to fill')
    await expect(app.window.getByText(/Open it with the page's own Apply button/)).toBeVisible()
    // The user (the test) presses the site's Apply; the form opens in a new tab.
    await clickLinkInTab(app.electronApp, '/company/posting-popup', '#apply')
    await expect.poll(async () => (await listTabs(app.electronApp)).length).toBe(2)
    await expectTabLoaded(app.electronApp, '/greenhouse/', 'Job Application for Software Engineer at Acme')
    await browser.apply.expectStatus('Filled: review and submit')
    await expectGreenhouseFilled(app, '/greenhouse/')
    expect(await exists(mock.submissionFile)).toBe(false)
  })

  test('a run whose application has no posting URL shows why Apply is disabled', async ({ app }) => {
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await tailor.start({
      description: '# Data Engineer\n\nNo Link Co is hiring. Python.',
      company: 'No Link Co',
      role: 'Data Engineer',
      jobId: 'NL-1'
    })
    await tailor.expectStatus('Waiting for you')
    await tailor.reply('Approved')
    await expect(tailor.outputLine('data-engineer/no-link-co/nl-1')).toBeVisible()
    await expect(tailor.outputButton('Apply')).toBeDisabled()
    await expect(tailor.applyReason).toHaveText('Apply: No posting URL: add it in the application drawer first.')
    expect(await listTabs(app.electronApp)).toEqual([])
  })
})
