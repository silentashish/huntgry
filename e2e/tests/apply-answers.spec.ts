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
 * no prompt and no model call. Unknown questions cost one tool-less model call
 * (the fake `claude`), which never sees a stored answer. Huntgry never
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

  const browser = await applyFromDashboard(app.window, 'Lever Mock', `${mock.origin}/lever/`)
  await expectTabLoaded(app.electronApp, '/lever/', 'Acme - Software Engineer')
  await browser.apply.expectStatus('Filled: review and submit')
  const gender = browser.apply.field('Gender')
  await expect(gender).toContainText('Answer it once below; Huntgry remembers it.')
  expect(await genderInTab(app.electronApp, '/lever/')).toBe('')

  // The questions nothing knows go to the model once: Haiku, no tools; the catalog's own (Gender) are not sent.
  await expect.poll(async () => (await oneShots()).length).toBe(1)
  const [call] = await oneShots()
  expect(call.agent).toBe('claude')
  expect(call.args![call.args!.indexOf('--model') + 1]).toBe('haiku')
  expect(call.args![call.args!.indexOf('--tools') + 1]).toBe('')
  expect(call.args).toContain('--no-session-persistence')
  expect(call.prompt).toContain('What interests you about this role?')
  expect(call.prompt).not.toContain('Gender')

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
  expect(JSON.parse(await readFile(join(app.sandbox.userData, 'apply-answers', stored[0]), 'utf8')).facts.gender.value).toBe('Female')
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
  expect(await oneShots()).toHaveLength(1)

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
