import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { WORKDAY_POSTING } from '../../scripts/mock-ats/workday.mjs'
import { withFakeAgents } from '../fixtures/fake-agent'
import { expect, test } from '../fixtures/servers/fixture'
import { evaluateInTab, expectTabLoaded } from '../fixtures/tabs'
import { BrowserPage } from '../pages/browser'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'

/**
 * Auto-apply on Workday (#65) against the mock Workday on 127.0.0.1
 * (scripts/mock-ats/workday.mjs): a client-rendered, multi-step flow whose
 * steps after sign-in keep the same URL. Huntgry fills My Information and
 * attaches resume.pdf on the resume step; it presses nothing. Every press
 * in the page here (Apply, the "how to apply" choice, Sign In, Create
 * Account, Next) is the test acting as the user, through `press` /
 * `signIn` (executeJavaScript in the tab). Nothing is submitted: the mock
 * flow ends at Application Questions.
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents() })

const PROFILE = {
  first: 'Alex',
  last: 'Rivera',
  email: 'alex.rivera@example.com',
  phone: '(555) 010-0199',
  city: 'Portland, OR',
  linkedin: 'https://www.linkedin.com/in/alex-rivera-example/'
}
const TAB = '/workday/'

const exists = (path: string) => access(path).then(() => true, () => false)
const aid = (id: string) => `[data-automation-id="${id}"]`
const value = (electronApp: ElectronApplication, selector: string) =>
  evaluateInTab<string | null>(electronApp, TAB, `document.querySelector(${JSON.stringify(selector)})?.value ?? null`)

interface Upload {
  site: string
  step?: string
  file: string
  type: string
  bytes: number
  sha256: string
}

/** What the mock Workday received (the mock ATS's uploads file, cleared before each test). */
async function uploads(uploadsFile: string): Promise<Upload[]> {
  const all: Upload[] = JSON.parse(await readFile(uploadsFile, 'utf8').catch(() => '[]'))
  return all.filter((u) => u.site === 'workday')
}

/** The user presses one of the page's own buttons (Huntgry never does). Waits for it to be drawn first. */
async function press(electronApp: ElectronApplication, id: string): Promise<void> {
  await expect.poll(() => evaluateInTab<boolean>(electronApp, TAB, `!!document.querySelector('${aid(id)}')`), { message: id }).toBe(true)
  await evaluateInTab(electronApp, TAB, `(document.querySelector('${aid(id)}').click(), true)`)
}

/** The user signs in (or creates the account) on the wall: types the credentials and presses the button. */
async function signIn(electronApp: ElectronApplication, button: 'signInSubmitButton' | 'createAccountSubmitButton'): Promise<void> {
  await evaluateInTab(
    electronApp,
    TAB,
    `(() => {
      const set = (id, v) => { const el = document.querySelector('[data-automation-id="' + id + '"]'); if (el) el.value = v }
      set('email', 'alex.rivera@example.com')
      set('password', 'not-a-real-password')
      set('verifyPassword', 'not-a-real-password')
      const box = document.querySelector('[data-automation-id="createAccountCheckbox"]')
      if (box) box.checked = true
      return true
    })()`
  )
  await press(electronApp, button)
}

/** What Workday's resume widget lists (`file-upload-successful`), or null while it has nothing. */
const uploadedList = (electronApp: ElectronApplication) =>
  evaluateInTab<string | null>(electronApp, TAB, `document.querySelector('${aid('file-upload-successful')}')?.textContent.trim() ?? null`)

/** The sign-in wall's fields, which must stay empty whatever Huntgry does. */
const wallValues = (electronApp: ElectronApplication) =>
  evaluateInTab<Array<string | boolean | null>>(
    electronApp,
    TAB,
    `['email', 'password', 'verifyPassword', 'beecatcher', 'createAccountCheckbox'].map((id) => {
      const el = document.querySelector('[data-automation-id="' + id + '"]')
      return el ? (el.type === 'checkbox' ? el.checked : el.value) : null
    })`
  )

/** PNGs for the PR and the HTML report: the page (the tab's own pixels) and the app window with the Apply panel. */
async function screenshots(app: { electronApp: ElectronApplication; window: Page }, testInfo: TestInfo, name: string, scrollTo: string) {
  await evaluateInTab(app.electronApp, TAB, `document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: 'center' })`)
  const png = await app.electronApp.evaluate(async ({ BrowserWindow }, tab) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.contentView)
    const view = win?.contentView.children.find((v) => (v as Electron.WebContentsView).webContents.getURL().includes(tab))
    const image = await (view as Electron.WebContentsView).webContents.capturePage()
    return image.toPNG().toString('base64')
  }, TAB)
  const page = testInfo.outputPath(`${name}-page.png`)
  await writeFile(page, Buffer.from(png, 'base64'))
  await testInfo.attach(`${name}-page`, { path: page, contentType: 'image/png' })
  const window = testInfo.outputPath(`${name}-app.png`)
  await app.window.screenshot({ path: window })
  await testInfo.attach(`${name}-app`, { path: window, contentType: 'image/png' })
}

test.describe('apply on Workday', () => {
  test('a generated resume: Tailor run → Apply → posting, choice, sign-in wall (nothing filled) → My Information filled → resume attached', async ({
    app,
    mock
  }, testInfo) => {
    const posting = `${mock.origin}${WORKDAY_POSTING}`
    const folder = 'software-engineer/acme/jr-1001'

    // Tailor a resume for the Workday posting with the scripted agent, then press the run's Apply.
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await tailor.jobUrl.fill(posting)
    await tailor.start({
      description: '# Software Engineer\n\nAcme is hiring a Software Engineer. TypeScript, Go, PostgreSQL.',
      company: 'Acme',
      role: 'Software Engineer',
      jobId: 'JR-1001'
    })
    await tailor.expectStatus('Waiting for you')
    await tailor.reply('Approved')
    await expect(tailor.outputLine(folder)).toContainText('resume.pdf')
    const resumeFile = join(app.workspace!, folder, 'resume.pdf')
    const resumeBytes = (await stat(resumeFile)).size
    const resumeSha = createHash('sha256').update(await readFile(resumeFile)).digest('hex')
    await tailor.outputButton('Apply').click()

    await new Shell(app.window).expectActive('browser')
    const browser = new BrowserPage(app.window)
    const panel = browser.apply
    await expect(browser.address).toHaveValue(posting)
    await expectTabLoaded(app.electronApp, TAB, 'Software Engineer')

    // The posting (drawn after load): the panel says to press Apply; Huntgry does not.
    await panel.expectStatus('Your turn in the page')
    await expect(app.window.getByText('Workday', { exact: true })).toBeVisible()
    await expect(app.window.getByText('Step: Job posting', { exact: true })).toBeVisible()
    await expect(app.window.getByText(/Press "Apply" in the page yourself/)).toBeVisible()
    await app.window.waitForTimeout(800)
    expect(await evaluateInTab<string>(app.electronApp, TAB, 'location.pathname')).toBe(WORKDAY_POSTING)

    // The user presses Apply: the choice. The panel names both buttons and presses neither.
    await press(app.electronApp, 'adventureButton')
    await expect(app.window.getByText('Step: How to apply (Start Your Application)', { exact: true })).toBeVisible()
    await expect(app.window.getByText(/"Autofill with Resume".*"Apply Manually"/)).toBeVisible()
    await app.window.waitForTimeout(800)
    expect(await evaluateInTab<string>(app.electronApp, TAB, 'location.pathname')).toBe(`${WORKDAY_POSTING}/apply`)

    // Apply Manually → the sign-in wall: nothing is typed, not even the email; never the password or the honeypot.
    await press(app.electronApp, 'applyManually')
    await expect(app.window.getByText('Step: Sign in or create account (Create Account/Sign In)', { exact: true })).toBeVisible()
    await expect(app.window.getByText(/Sign in or create your Workday account in the page yourself/)).toBeVisible()
    await panel.expectStatus('Your turn in the page')
    await app.window.waitForTimeout(1500)
    expect(await wallValues(app.electronApp)).toEqual(['', '', null, '', null])
    await panel.fillButton.click()
    await expect(app.window.getByText(/Sign in or create your Workday account/)).toBeVisible()
    expect(await wallValues(app.electronApp)).toEqual(['', '', null, '', null])
    expect(await uploads(mock.uploadsFile)).toEqual([])

    // The user signs in; Workday swaps in My Information at the same URL, and Huntgry fills it on its own.
    await signIn(app.electronApp, 'signInSubmitButton')
    await expect(app.window.getByText('Step: My Information', { exact: true })).toBeVisible()
    await panel.expectStatus('Filled: review and submit')
    expect(await value(app.electronApp, '#name--legalName--firstName')).toBe(PROFILE.first)
    expect(await value(app.electronApp, '#name--legalName--lastName')).toBe(PROFILE.last)
    expect(await value(app.electronApp, '#emailAddress--emailAddress')).toBe(PROFILE.email)
    expect(await value(app.electronApp, '#phoneNumber--phoneNumber')).toBe(PROFILE.phone)
    expect(await value(app.electronApp, '#address--city')).toBe(PROFILE.city)
    expect(await value(app.electronApp, aid('beecatcher'))).toBe('')
    expect(await value(app.electronApp, '#phoneNumber--extension')).toBe('')
    for (const shown of [PROFILE.first, PROFILE.last, PROFILE.email, PROFILE.phone, PROFILE.city]) {
      await expect(app.window.getByText(shown, { exact: true }).locator('..')).toContainText('Filled')
    }
    await expect(app.window.getByText(/^Country Phone Code/).locator('..')).toContainText('Your choice')
    await screenshots(app, testInfo, 'workday-my-information', '#name--legalName--firstName')

    // The user presses Save and Continue: My Experience (same URL). resume.pdf goes to the drop zone and counts
    // once Workday's widget lists it; the mock received this run's file.
    await press(app.electronApp, 'bottom-navigation-next-button')
    await expect(app.window.getByText('Step: My Experience', { exact: true })).toBeVisible()
    await panel.expectStatus('Filled: review and submit')
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')
    expect(await uploadedList(app.electronApp)).toContain('resume.pdf')
    expect(await uploads(mock.uploadsFile)).toEqual([
      expect.objectContaining({ file: 'resume.pdf', type: 'application/pdf', bytes: resumeBytes, sha256: resumeSha, step: 'my-experience' })
    ])
    expect(await value(app.electronApp, aid('linkedinQuestion'))).toBe(PROFILE.linkedin)
    await screenshots(app, testInfo, 'workday-resume', aid('file-upload-successful'))

    // Application Questions is the user's; Huntgry says so and fills nothing.
    await press(app.electronApp, 'bottom-navigation-next-button')
    await expect(app.window.getByText('Step: Other step (Application Questions)', { exact: true })).toBeVisible()
    await panel.expectStatus('Your turn in the page')
    expect(await value(app.electronApp, 'textarea')).toBe('')
    expect(await uploads(mock.uploadsFile)).toHaveLength(1)
    expect(await exists(mock.submissionFile)).toBe(false)
  })

  test('Autofill with Resume on an older tenant: create-account wall untouched, resume attached after the parse, then My Information', async ({
    app,
    mock
  }) => {
    const shell = new Shell(app.window)
    await shell.expectActive('dashboard')
    await app.window.getByRole('row').filter({ hasText: 'Workday Mock' }).getByRole('button', { name: 'Apply', exact: true }).click()
    await shell.expectActive('browser')
    const browser = new BrowserPage(app.window)
    const panel = browser.apply
    await expect(browser.address).toHaveValue(`${mock.origin}${WORKDAY_POSTING}?tenant=legacy`)
    await expect(app.window.getByText('Step: Job posting', { exact: true })).toBeVisible()

    await press(app.electronApp, 'adventureButton')
    await press(app.electronApp, 'autofillWithResume')
    await expect(app.window.getByText('Step: Sign in or create account (Create Account/Sign In)', { exact: true })).toBeVisible()
    // The user switches to Create Account: still the wall, still untouched.
    await press(app.electronApp, 'createAccountLink')
    await expect.poll(() => evaluateInTab<boolean>(app.electronApp, TAB, `!!document.querySelector('${aid('verifyPassword')}')`)).toBe(true)
    await app.window.waitForTimeout(1500)
    await panel.expectStatus('Your turn in the page')
    expect(await wallValues(app.electronApp)).toEqual(['', '', '', '', false])

    // Account created → "Autofill with Resume": the resume goes in and counts once Workday's widget lists it. Workday
    // then reads it (about 3 s), and that parse will rewrite My Information.
    await signIn(app.electronApp, 'createAccountSubmitButton')
    await expect(app.window.getByText('Step: Autofill with Resume', { exact: true })).toBeVisible()
    await panel.expectStatus('Filled: review and submit')
    expect(await uploadedList(app.electronApp)).toBe('resume.pdf Successfully Uploaded! Delete')
    await expect(app.window.getByText('resume.pdf', { exact: true }).locator('..')).toContainText('Attached')
    expect(await uploads(mock.uploadsFile)).toEqual([expect.objectContaining({ file: 'resume.pdf', step: 'autofill-resume' })])

    // The user continues while Workday is still reading: My Information opens under its banner. #63's readiness wait
    // holds the detect until Workday is ready, so Huntgry neither fills nor reports the step while the parser runs.
    await press(app.electronApp, 'bottom-navigation-next-button')
    await expect
      .poll(() => evaluateInTab<boolean>(app.electronApp, TAB, `!!document.querySelector('${aid('legalNameSection_firstName')}')`))
      .toBe(true)
    expect(await evaluateInTab<boolean>(app.electronApp, TAB, `!!document.querySelector('${aid('resumeParsing')}')`)).toBe(true)
    expect(await value(app.electronApp, aid('phone-number'))).toBe('')
    expect(await value(app.electronApp, aid('legalNameSection_firstName'))).toBe('')
    await expect(app.window.getByText('Step: My Information', { exact: true })).toHaveCount(0)

    // The parse ends and writes its values; then Huntgry fills only what it left empty and keeps the parser's.
    await expect(app.window.getByText('Step: My Information', { exact: true })).toBeVisible()
    await panel.expectStatus('Filled: review and submit')
    expect(await evaluateInTab<boolean>(app.electronApp, TAB, `!!document.querySelector('${aid('resumeParsing')}')`)).toBe(false)
    expect(await value(app.electronApp, aid('legalNameSection_firstName'))).toBe('Alexander')
    expect(await value(app.electronApp, aid('legalNameSection_lastName'))).toBe(PROFILE.last)
    expect(await value(app.electronApp, aid('email'))).toBe('alex.rivera@parsed.example')
    expect(await value(app.electronApp, aid('phone-number'))).toBe(PROFILE.phone)
    expect(await value(app.electronApp, aid('addressSection_city'))).toBe(PROFILE.city)
    await expect(app.window.getByText('Alexander', { exact: true }).locator('..')).toContainText('Kept yours')
    await expect(app.window.getByText('alex.rivera@parsed.example', { exact: true }).locator('..')).toContainText('Kept yours')
    await expect(app.window.getByText(PROFILE.phone, { exact: true }).locator('..')).toContainText('Filled')
    expect(await value(app.electronApp, aid('beecatcher'))).toBe('')
    expect(await uploads(mock.uploadsFile)).toHaveLength(1)
    expect(await exists(mock.submissionFile)).toBe(false)
  })
})
