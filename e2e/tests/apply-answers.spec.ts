import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { fakeAgents, withFakeAgents } from '../fixtures/fake-agent'
import { expect, test } from '../fixtures/servers/fixture'
import { evaluateInTab, expectTabLoaded } from '../fixtures/tabs'
import { BrowserPage } from '../pages/browser'
import { Shell } from '../pages/shell'

/**
 * Remembered application answers (#71) against the mock Lever form: the
 * Gender question (a native select) is answered once in the Apply panel with
 * "Remember", and a second application with the same question fills it with
 * no prompt and no mapping call. Unknown questions cost one tool-less model call
 * (the fake `claude`), which never sees a stored answer; open-ended ones get a
 * draft per application (#82). Huntgry never
 * submits; nothing presses the form's Submit here at all.
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents() })

const exists = (path: string) => access(path).then(() => true, () => false)
const genderInTab = (electronApp: ElectronApplication, urlPart: string) =>
  evaluateInTab<string>(electronApp, urlPart, `document.querySelector('select[name="eeo[gender]"]').value`)

async function applyFromDashboard(page: Page, company: string, urlPart: string): Promise<BrowserPage> {
  const shell = new Shell(page)
  await shell.expectActive('dashboard')
  await page.getByRole('row').filter({ hasText: company }).getByRole('button', { name: 'Apply', exact: true }).click()
  await shell.expectActive('browser')
  const browser = new BrowserPage(page)
  await expect(browser.address).toHaveValue(new RegExp(urlPart.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  return browser
}

/** Every file below `dir` (relative paths). */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
}

test('a question answered once in the Apply panel fills itself on the next application', async ({ app, mock }) => {
  const agents = fakeAgents(app)
  const oneShots = async () => (await agents.invocations()).filter((i) => i.mode === 'oneshot')
  const model = (i: { args?: string[] }) => i.args![i.args!.indexOf('--model') + 1]
  const mappingCalls = async () => (await oneShots()).filter((i) => model(i) === 'haiku')
  const draftCalls = async () => (await oneShots()).filter((i) => model(i) === 'sonnet')

  const browser = await applyFromDashboard(app.window, 'Lever Mock', `${mock.origin}/lever/`)
  await expectTabLoaded(app.electronApp, '/lever/', 'Acme - Software Engineer')
  await browser.apply.expectStatus('Filled: review and submit')
  const gender = browser.apply.field('Gender')
  await expect(gender).toContainText('Answer it once below; Huntgry remembers it.')
  expect(await genderInTab(app.electronApp, '/lever/')).toBe('')

  // The questions nothing knows go to the model once: Haiku, no tools; the catalog's own (Gender) are not sent.
  await expect.poll(async () => (await mappingCalls()).length).toBe(1)
  const [call] = await mappingCalls()
  expect(call.agent).toBe('claude')
  expect(call.args![call.args!.indexOf('--tools') + 1]).toBe('')
  expect(call.args).toContain('--no-session-persistence')
  expect(call.prompt).toContain('What interests you about this role?')
  expect(call.prompt).not.toContain('Gender')

  // Open-ended questions get an AI draft (#82) from the job description and the profile, typed into the page.
  // A required question's label ends with its " *".
  const interests = browser.apply.field('What interests you about this role? *')
  await expect(interests).toContainText('AI draft')
  await expect(interests).toContainText('Fake draft: What interests you about this role?')
  expect(await evaluateInTab<string>(app.electronApp, '/lever/', `document.querySelector('textarea').value`)).toBe(
    'Fake draft: What interests you about this role?'
  )
  const drafts = await draftCalls()
  expect(drafts).toHaveLength(1)
  expect(drafts[0].args![drafts[0].args!.indexOf('--tools') + 1]).toBe('')
  expect(drafts[0].prompt).toContain('Job description:')
  expect(drafts[0].prompt).toContain('What interests you about this role?')
  expect(drafts[0].prompt).not.toContain('Gender')

  // Answer it once, remembered.
  await gender.getByRole('button', { name: 'Answer Gender' }).click()
  await gender.getByLabel('Answer for Gender').selectOption('Female')
  await expect(gender.getByLabel('Remember for next applications')).toBeChecked()
  await expect(gender).toContainText('never sent to the AI model')
  await gender.getByRole('button', { name: 'Use', exact: true }).click()
  await expect(browser.apply.field('Gender')).toContainText('Filled')
  await expect.poll(() => genderInTab(app.electronApp, '/lever/')).toBe('Female')

  // Kept with the app's data, never in the workspace.
  const stored = (await filesBelow(join(app.sandbox.userData, 'apply-answers'))).filter((f) => f.endsWith('answers.json'))
  expect(stored).toHaveLength(1)
  const memory = await readFile(join(app.sandbox.userData, 'apply-answers', stored[0]), 'utf8')
  expect(JSON.parse(memory).facts.gender.value).toBe('Female')
  // A draft belongs to its application: never remembered.
  expect(memory).not.toContain('Fake draft')
  expect((await filesBelow(app.workspace!)).filter((f) => /answers/.test(f))).toEqual([])

  // A second application with the same question: filled on its own, no prompt, no new model call.
  await browser.apply.endButton.click()
  await new Shell(app.window).goTo('dashboard')
  const second = await applyFromDashboard(app.window, 'Lever Second Mock', 'posting=2')
  await expectTabLoaded(app.electronApp, 'posting=2', 'Acme - Software Engineer')
  await second.apply.expectStatus('Filled: review and submit')
  await expect(second.apply.field('Gender')).toContainText('Filled')
  await expect(second.apply.field('Gender')).toContainText('Female')
  expect(await genderInTab(app.electronApp, 'posting=2')).toBe('Female')
  // No new mapping call; the new application gets its own draft.
  expect(await mappingCalls()).toHaveLength(1)
  await expect.poll(async () => (await draftCalls()).length).toBe(2)

  // Settings lists it, masked until shown.
  await second.apply.endButton.click()
  await new Shell(app.window).goTo('settings')
  const card = app.window.getByRole('table', { name: 'Saved application answers' })
  await expect(card.getByText('Gender', { exact: true })).toBeVisible()
  await expect(card.getByText('Female')).toHaveCount(0)
  await card.getByRole('button', { name: 'Show Gender' }).click()
  await expect(card.getByText('Female')).toBeVisible()

  // Nothing was ever submitted.
  expect(await exists(mock.submissionFile)).toBe(false)
})

const genderPicked = (electronApp: ElectronApplication, urlPart: string) =>
  evaluateInTab<string>(
    electronApp,
    urlPart,
    `document.getElementById('question_gender').closest('.select__container').querySelector('.select__single-value')?.textContent ?? ''`
  )

test('a dropdown answered once is picked automatically on the next Greenhouse application', async ({ app, mock }) => {
  const browser = await applyFromDashboard(app.window, 'Greenhouse Mock', `${mock.origin}/greenhouse/`)
  await expectTabLoaded(app.electronApp, '/greenhouse/', 'Job Application for Software Engineer at Acme')
  await browser.apply.expectStatus('Filled: review and submit')
  // A react-select question (the mock's Gender): nothing saved yet, so it asks.
  const gender = browser.apply.field('Gender')
  await expect(gender).toContainText('Answer it once below; Huntgry remembers it.')
  expect(await genderPicked(app.electronApp, '/greenhouse/')).toBe('')

  // Answered once in the panel: Huntgry picks it in the page's dropdown (pointer events on its own option only).
  await gender.getByRole('button', { name: 'Answer Gender' }).click()
  await gender.getByLabel('Answer for Gender').fill('Female')
  await gender.getByRole('button', { name: 'Use', exact: true }).click()
  await expect(browser.apply.field('Gender')).toContainText('Filled')
  await expect.poll(() => genderPicked(app.electronApp, '/greenhouse/')).toBe('Female')

  // The next application picks it on its own.
  await browser.apply.endButton.click()
  await new Shell(app.window).goTo('dashboard')
  const second = await applyFromDashboard(app.window, 'Greenhouse Second Mock', 'posting=2')
  await expectTabLoaded(app.electronApp, 'posting=2', 'Job Application for Software Engineer at Acme')
  await second.apply.expectStatus('Filled: review and submit')
  await expect(second.apply.field('Gender')).toContainText('Filled')
  await expect(second.apply.field('Gender')).toContainText('Female')
  expect(await genderPicked(app.electronApp, 'posting=2')).toBe('Female')

  // The switch is on by default in Settings.
  await second.apply.endButton.click()
  await new Shell(app.window).goTo('settings')
  await expect(app.window.getByRole('switch', { name: 'Pick dropdown answers automatically' })).toBeChecked()

  // Picking never submits: the mock recorded nothing.
  expect(await exists(mock.submissionFile)).toBe(false)
})
