import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/servers/fixture'
import { evaluateInTab, expectTabLoaded, listTabs, pressSubmitInTab } from '../fixtures/tabs'
import { BrowserPage } from '../pages/browser'
import { Shell } from '../pages/shell'

/**
 * Auto-apply against the mock ATS on 127.0.0.1 (the same forms as
 * `node scripts/mock-ats.mjs`). Huntgry fills and attaches; it never submits.
 * The ONLY thing that presses a Submit button in these tests is the test
 * itself, through `pressSubmitInTab` (executeJavaScript in the tab), after
 * answering what the form still needs. The mock records what it received to
 * `last-submission.json`, which is what the assertions read.
 */
test.use({ workspace: 'mocks' })

const exists = (path: string) => access(path).then(() => true, () => false)
const tracking = async (workspace: string, id: string) => JSON.parse(await readFile(join(workspace, id, 'huntgry.json'), 'utf8'))
const today = () => new Date().toISOString().slice(0, 10)

/** The Apply button of a Dashboard row (rows are named by the humanized company folder). */
function applyButton(page: Page, company: string) {
  return page.getByRole('row').filter({ hasText: company }).getByRole('button', { name: 'Apply', exact: true })
}

/** Starts Apply from the Dashboard row and waits for the Browser page with the session's tab. */
async function applyFromDashboard(page: Page, company: string, urlPart: string): Promise<BrowserPage> {
  const shell = new Shell(page)
  await shell.expectActive('dashboard')
  await applyButton(page, company).click()
  await shell.expectActive('browser')
  const browser = new BrowserPage(page)
  await expect(browser.address).toHaveValue(new RegExp(urlPart.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  return browser
}

test.describe('apply', () => {
  test('Apply from a Dashboard row fills the Lever form, the test submits it, "Mark as applied" updates huntgry.json', async ({
    app,
    mock
  }) => {
    const browser = await applyFromDashboard(app.window, 'Lever Mock', `${mock.origin}/lever/`)
    await expectTabLoaded(app.electronApp, '/lever/', 'Acme - Software Engineer')
    await expect(browser.apply.endButton).toBeVisible()
    await expect(app.window.getByText('Software Engineer · Lever Mock')).toBeVisible()
    await browser.apply.expectStatus('Filled: review and submit')
    await expect(app.window.getByText('Lever', { exact: true })).toBeVisible()
    await expect(app.window.getByText(/^Filled \d+ fields\./)).toBeVisible()
    await expect(app.window.getByText('Huntgry never submits.')).toBeVisible()

    // What was filled, what was attached, what is left to the user.
    await expect(browser.apply.group('Filled')).toBeVisible()
    await expect(browser.apply.group('Needs you')).toBeVisible()
    await expect(browser.apply.group('Your choice')).toBeVisible()
    for (const value of ['Alex Rivera', 'alex.rivera@example.com', '(555) 010-0199', 'Portland, OR', 'https://github.com/alex-rivera-example']) {
      await expect(app.window.getByText(value, { exact: true }).locator('..')).toContainText('Filled')
    }
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')
    await expect(app.window.getByText('Not in your master profile.').first()).toBeVisible()
    // The page itself holds the values (read through the main process, since the tab is a native view).
    expect(await evaluateInTab<string>(app.electronApp, '/lever/', 'document.querySelector(\'input[name="email"]\').value')).toBe(
      'alex.rivera@example.com'
    )
    expect(await evaluateInTab<number>(app.electronApp, '/lever/', 'document.querySelector(\'input[name="resume"]\').files.length')).toBe(1)
    expect(await exists(mock.submissionFile)).toBe(false)

    // The test, not the app, answers the required question and presses the site's Submit.
    await pressSubmitInTab(app.electronApp, '/lever/', { 'textarea[required]': 'Yes, remote from Portland.' })
    await expectTabLoaded(app.electronApp, '/lever/thanks', 'Acme')
    const submission = JSON.parse(await readFile(mock.submissionFile, 'utf8'))
    expect(submission.site).toBe('lever')
    expect(submission.fields).toMatchObject({
      name: 'Alex Rivera',
      email: 'alex.rivera@example.com',
      phone: '(555) 010-0199',
      location: 'Portland, OR',
      'urls[LinkedIn]': 'https://www.linkedin.com/in/alex-rivera-example/',
      resume: { file: 'resume.pdf', type: 'application/pdf', bytes: 780 }
    })

    // The confirmation page is detected; nothing changes until "Mark as applied".
    await browser.apply.expectStatus('Submitted')
    await expect(browser.apply.confirmedText).toBeVisible()
    expect(await tracking(app.workspace!, 'software-engineer/lever-mock/lv-1')).toMatchObject({ status: 'generated' })
    await browser.apply.markAppliedButton.click()
    await expect(app.window.getByText(`Marked as applied on ${today()}.`)).toBeVisible()
    expect(await tracking(app.workspace!, 'software-engineer/lever-mock/lv-1')).toMatchObject({
      status: 'applied',
      appliedAt: today(),
      jobUrl: `${mock.origin}/lever/`
    })
    await app.window.getByRole('button', { name: 'Done' }).click()
    await expect(browser.apply.endButton).toHaveCount(0)
  })

  test('a generic form gets resume.pdf and cover.pdf; "Not yet" leaves huntgry.json alone', async ({ app, mock }) => {
    const browser = await applyFromDashboard(app.window, 'Generic Mock', `${mock.origin}/generic-cover/`)
    await expectTabLoaded(app.electronApp, '/generic-cover/', 'Apply - Software Engineer - Example Co')
    await browser.apply.expectStatus('Filled: review and submit')
    await expect(app.window.getByText('Unknown site (generic matching)')).toBeVisible()
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')
    await expect(app.window.getByText('cover.pdf', { exact: true }).locator('..')).toContainText('Attached')
    await expect(app.window.getByText('Alex', { exact: true }).locator('..')).toContainText('Filled')
    await expect(app.window.getByText('Rivera', { exact: true }).locator('..')).toContainText('Filled')

    await pressSubmitInTab(app.electronApp, '/generic-cover/', { 'input[name="consent"]': true })
    await expectTabLoaded(app.electronApp, '/generic-cover/thanks', 'Example Co')
    const submission = JSON.parse(await readFile(mock.submissionFile, 'utf8'))
    expect(submission.site).toBe('generic-cover')
    expect(submission.fields).toMatchObject({
      applicant_a: 'Alex',
      applicant_b: 'Rivera',
      contact: 'alex.rivera@example.com',
      attachment_1: { file: 'resume.pdf', bytes: 786 },
      cover_letter: { file: 'cover.pdf', bytes: 767 }
    })

    await browser.apply.expectStatus('Submitted')
    await browser.apply.notYetButton.click()
    await expect(app.window.getByText('This looked like a confirmation page. If the form is still open, press Fill form.')).toBeVisible()
    await expect(browser.apply.markAppliedButton).toHaveCount(0)
    expect(await tracking(app.workspace!, 'software-engineer/generic-mock/gen-1')).toEqual({
      status: 'generated',
      notes: '',
      jobUrl: `${mock.origin}/generic-cover/`
    })
  })

  test('the Greenhouse form is recognised and its confirmation page detected', async ({ app, mock }) => {
    const browser = await applyFromDashboard(app.window, 'Greenhouse Mock', `${mock.origin}/greenhouse/`)
    await expectTabLoaded(app.electronApp, '/greenhouse/', 'Job Application for Software Engineer at Acme')
    await browser.apply.expectStatus('Filled: review and submit')
    await expect(app.window.getByText('Greenhouse', { exact: true })).toBeVisible()
    await expect(app.window.getByText('Alex', { exact: true }).locator('..')).toContainText('Filled')
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')

    await pressSubmitInTab(app.electronApp, '/greenhouse/')
    await expectTabLoaded(app.electronApp, '/greenhouse/confirmation', 'Acme')
    const submission = JSON.parse(await readFile(mock.submissionFile, 'utf8'))
    expect(submission.fields).toMatchObject({
      first_name: 'Alex',
      last_name: 'Rivera',
      email: 'alex.rivera@example.com',
      resume: { file: 'resume.pdf' }
    })
    await browser.apply.expectStatus('Submitted')
    await expect(browser.apply.markAppliedButton).toBeVisible()
  })

  test('an application already marked as applied asks first', async ({ app, mock }) => {
    await applyButton(app.window, 'Applied Mock').click()
    const question = app.window.getByRole('dialog', { name: 'Already applied' })
    await expect(question).toBeVisible()
    await expect(question).toContainText('You marked this application as applied on 2026-09-20. Open the apply page anyway?')
    await question.getByRole('button', { name: 'Cancel' }).click()
    await expect(question).toBeHidden()
    await new Shell(app.window).expectActive('dashboard')
    expect(await listTabs(app.electronApp)).toEqual([])

    await applyButton(app.window, 'Applied Mock').click()
    await question.getByRole('button', { name: 'Open apply page' }).click()
    await new Shell(app.window).expectActive('browser')
    await expect(new BrowserPage(app.window).address).toHaveValue(`${mock.origin}/lever/`)
    await new BrowserPage(app.window).apply.expectStatus('Filled: review and submit')
  })

  test('a redirect to another origin is not filled until "Fill form" is pressed', async ({ app, mock }) => {
    const browser = await applyFromDashboard(app.window, 'Redirect Mock', `${mock.altOrigin}/lever/`)
    await expectTabLoaded(app.electronApp, `${mock.altOrigin}/lever/`, 'Acme - Software Engineer')
    await browser.apply.expectStatus('Ready to fill')
    await expect(
      app.window.getByText(
        `This page is on 127.0.0.1:${mock.altPort}, not the posting's site, so Huntgry did not fill it. If it is the application form, press Fill form.`
      )
    ).toBeVisible()
    expect(await evaluateInTab<string>(app.electronApp, '/lever/', 'document.querySelector(\'input[name="email"]\').value')).toBe('')

    await browser.apply.fillButton.click()
    await browser.apply.expectStatus('Filled: review and submit')
    expect(await evaluateInTab<string>(app.electronApp, '/lever/', 'document.querySelector(\'input[name="email"]\').value')).toBe(
      'alex.rivera@example.com'
    )
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')
  })

  test('an application without resume.pdf cannot apply, and the reason is shown', async ({ app }) => {
    const button = applyButton(app.window, 'No Resume Mock')
    await expect(button).toBeDisabled()
    await button.hover({ force: true })
    await expect(app.window.getByText('No resume.pdf yet: build the resume in Tailor first.')).toBeVisible()
    // The application drawer says the same on its own Apply button.
    await app.window.getByRole('row').filter({ hasText: 'No Resume Mock' }).getByText('No Resume Mock').click()
    await expect(app.window.getByRole('dialog').getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
  })

  test('a second Apply while one is opening is refused', async ({ app, mock }) => {
    // Two starts in the same tick, straight through the preload bridge (two windows or two quick clicks would do the same).
    const outcomes = await app.window.evaluate(async () => {
      const api = (window as unknown as { huntgry: { apply: { start(id: string): Promise<unknown> } } }).huntgry
      const results = await Promise.allSettled([
        api.apply.start('software-engineer/lever-mock/lv-1'),
        api.apply.start('software-engineer/greenhouse-mock/gh-1')
      ])
      return results.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message))
    })
    expect(outcomes[0]).toBe('ok')
    expect(outcomes[1]).toContain('Another Apply is still starting. Try again in a moment.')
    // Only the first session's tab exists.
    await expect.poll(() => listTabs(app.electronApp).then((tabs) => tabs.map((t) => t.url))).toEqual([`${mock.origin}/lever/`])
  })
})
