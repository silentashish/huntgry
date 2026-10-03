import { access, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { ashbyUploadsFile, type AshbyUpload } from '../../scripts/mock-ats/ashby.mjs'
import { withFakeAgents } from '../fixtures/fake-agent'
import { expect, test } from '../fixtures/servers/fixture'
import { evaluateInTab, expectTabLoaded } from '../fixtures/tabs'
import { BrowserPage } from '../pages/browser'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'

/**
 * Auto-apply on Ashby (#64) against the mock Ashby on 127.0.0.1
 * (scripts/mock-ats/ashby.mjs): a client-rendered page whose form appears
 * after `load`, with Ashby's resume widget (upload, then the file listed
 * with "Replace") and its "Autofill from resume" parser pane. Huntgry fills
 * and attaches; it never submits. The only Submit press is the test's own
 * (`submitInTab`), after which the mock records what it received.
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents() })

const PROFILE = {
  name: 'Alex Rivera',
  email: 'alex.rivera@example.com',
  phone: '(555) 010-0199',
  linkedin: 'https://www.linkedin.com/in/alex-rivera-example/'
}
/** The mock's custom questions (fake UUIDs of the captured form). */
const PHONE = 'a5b00003-0000-4000-8000-000000000003'
const LINKEDIN = 'a5b0ffff-0000-4000-8000-00000000ffff'

const exists = (path: string) => access(path).then(() => true, () => false)
const value = (electronApp: ElectronApplication, selector: string) =>
  evaluateInTab<string>(electronApp, '/ashby/', `document.querySelector(${JSON.stringify(selector)}).value`)

async function uploads(submissionFile: string): Promise<AshbyUpload[]> {
  return JSON.parse(await readFile(ashbyUploadsFile(submissionFile), 'utf8').catch(() => '[]'))
}

/** Ashby's file widget: the listed file name, whether it has its delete button, and the dropzone button text. */
function resumeWidget(electronApp: ElectronApplication) {
  return evaluateInTab<{ name: string | null; done: boolean; button: string }>(
    electronApp,
    '/ashby/',
    `(() => {
      const w = document.getElementById('_systemfield_resume').closest('.ashby-application-form-input-file')
      return {
        name: w.querySelector('.ashby-application-form-input-file-item-name')?.textContent.trim() ?? null,
        done: !!w.querySelector('.ashby-application-form-input-file-item-delete'),
        button: w.querySelector('.ashby-application-form-input-file-dropzone-upload').textContent.trim()
      }
    })()`
  )
}

/** The test, never the app, presses Ashby's Submit (a plain button: Ashby has no <form>). */
function submitInTab(electronApp: ElectronApplication): Promise<boolean> {
  return evaluateInTab<boolean>(electronApp, '/ashby/', `(document.querySelector('.ashby-application-form-submit-button').click(), true)`)
}

/** PNGs for the PR and the HTML report: the page (the tab's own pixels) and the app window with the Apply panel. */
async function screenshots(app: { electronApp: ElectronApplication; window: Page }, testInfo: TestInfo, name: string) {
  // Scrolled to the contact fields and the resume widget (a scroll only; nothing on the page is pressed).
  await evaluateInTab(app.electronApp, '/ashby/', `document.getElementById('_systemfield_name').closest('.ashby-application-form-field-entry').scrollIntoView()`)
  const png = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.contentView)
    const view = win?.contentView.children.find((v) => (v as Electron.WebContentsView).webContents.getURL().includes('/ashby/'))
    const image = await (view as Electron.WebContentsView).webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  const page = testInfo.outputPath(`${name}-page.png`)
  await writeFile(page, Buffer.from(png, 'base64'))
  await testInfo.attach(`${name}-page`, { path: page, contentType: 'image/png' })
  const window = testInfo.outputPath(`${name}-app.png`)
  await app.window.screenshot({ path: window })
  await testInfo.attach(`${name}-app`, { path: window, contentType: 'image/png' })
}

test.describe('apply on Ashby', () => {
  test.beforeEach(async ({ mock }) => {
    await rm(ashbyUploadsFile(mock.submissionFile), { force: true })
  })

  test('a generated resume: Tailor run → Apply → the late Ashby form gets resume.pdf and the contact fields', async ({
    app,
    mock
  }, testInfo) => {
    const posting = `${mock.origin}/ashby/`
    const folder = 'software-engineer/acme/as-7'

    // Tailor a resume for the Ashby posting with the scripted agent, then press the run's Apply.
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await tailor.jobUrl.fill(posting)
    await tailor.start({
      description: '# Software Engineer\n\nAcme is hiring a Software Engineer. TypeScript, Go, PostgreSQL.',
      company: 'Acme',
      role: 'Software Engineer',
      jobId: 'AS-7'
    })
    await tailor.expectStatus('Waiting for you')
    await tailor.reply('Approved')
    await expect(tailor.outputLine(folder)).toContainText('resume.pdf')
    const resume = join(app.workspace!, folder, 'resume.pdf')
    const resumeBytes = (await stat(resume)).size
    await tailor.outputButton('Apply').click()

    await new Shell(app.window).expectActive('browser')
    const browser = new BrowserPage(app.window)
    await expect(browser.address).toHaveValue(posting)
    await expectTabLoaded(app.electronApp, '/ashby/', 'Software Engineer @ Acme')
    await browser.apply.expectStatus('Filled: review and submit')
    await expect(app.window.getByText('Ashby', { exact: true })).toBeVisible()
    await expect(app.window.getByText('Software Engineer · Acme')).toBeVisible()

    // The page holds the profile's values, filled by label on the UUID custom questions.
    expect(await value(app.electronApp, '#_systemfield_name')).toBe(PROFILE.name)
    expect(await value(app.electronApp, '#_systemfield_email')).toBe(PROFILE.email)
    expect(await value(app.electronApp, `[id="${PHONE}"]`)).toBe(PROFILE.phone)
    expect(await value(app.electronApp, `[id="${LINKEDIN}"]`)).toBe(PROFILE.linkedin)
    for (const shown of [PROFILE.name, PROFILE.email, PROFILE.phone, PROFILE.linkedin]) {
      await expect(app.window.getByText(shown, { exact: true }).locator('..')).toContainText('Filled')
    }
    // The location autocomplete is the user's.
    expect(await value(app.electronApp, '.ashby-application-form-input-autocomplete')).toBe('')

    // Attached to #_systemfield_resume: Ashby's widget lists it with "Replace", and the mock received this run's file.
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')
    await expect.poll(() => resumeWidget(app.electronApp)).toEqual({ name: 'resume.pdf', done: true, button: 'Replace' })
    expect(await uploads(mock.submissionFile)).toEqual([
      expect.objectContaining({ kind: 'upload', file: 'resume.pdf', type: 'application/pdf', bytes: resumeBytes })
    ])
    // Never the "Autofill from resume" input (it would parse the file and overwrite the form).
    expect(
      await evaluateInTab<number>(app.electronApp, '/ashby/', `document.querySelector('.ashby-application-form-autofill-uploader input[type="file"]').files.length`)
    ).toBe(0)
    // Values verified after a settle: still there a moment later.
    await app.window.waitForTimeout(1500)
    expect(await value(app.electronApp, '#_systemfield_name')).toBe(PROFILE.name)
    expect(await exists(mock.submissionFile)).toBe(false)
    await screenshots(app, testInfo, 'ashby-filled')

    // The test presses Submit; Ashby swaps in its success panel without a navigation, and Huntgry notices.
    await submitInTab(app.electronApp)
    await browser.apply.expectStatus('Submitted')
    const submission = JSON.parse(await readFile(mock.submissionFile, 'utf8'))
    expect(submission.site).toBe('ashby')
    expect(submission.fields).toMatchObject({
      _systemfield_name: PROFILE.name,
      _systemfield_email: PROFILE.email,
      [PHONE]: PROFILE.phone,
      [LINKEDIN]: PROFILE.linkedin,
      _systemfield_resume: { file: 'resume.pdf', type: 'application/pdf', bytes: resumeBytes }
    })
  })

  test('values Ashby’s own autofill already put in are kept; only the empty fields are filled', async ({ app, mock }, testInfo) => {
    const shell = new Shell(app.window)
    await shell.expectActive('dashboard')
    await app.window.getByRole('row').filter({ hasText: 'Ashby Mock' }).getByRole('button', { name: 'Apply', exact: true }).click()
    await shell.expectActive('browser')
    const browser = new BrowserPage(app.window)
    await expect(browser.address).toHaveValue(`${mock.origin}/ashby/?parsed=1`)
    await browser.apply.expectStatus('Filled: review and submit')

    expect(await value(app.electronApp, '#_systemfield_name')).toBe('Parsed Name')
    expect(await value(app.electronApp, '#_systemfield_email')).toBe('parsed@example.com')
    await expect(app.window.getByText('Parsed Name', { exact: true }).locator('..')).toContainText('Kept yours')
    await expect(app.window.getByText('parsed@example.com', { exact: true }).locator('..')).toContainText('Kept yours')
    expect(await value(app.electronApp, `[id="${PHONE}"]`)).toBe(PROFILE.phone)
    expect(await value(app.electronApp, `[id="${LINKEDIN}"]`)).toBe(PROFILE.linkedin)
    await expect.poll(() => resumeWidget(app.electronApp)).toEqual({ name: 'resume.pdf', done: true, button: 'Replace' })
    expect((await uploads(mock.submissionFile)).map((u) => u.kind)).toEqual(['upload'])
    await screenshots(app, testInfo, 'ashby-kept')
  })
})
