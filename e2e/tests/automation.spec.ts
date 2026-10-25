import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { fakeAgents, withFakeAgents } from '../fixtures/fake-agent'
import { savedJob, seedJobs } from '../fixtures/queue'
import { expect, test } from '../fixtures/servers/fixture'
import { evaluateInTab, expectTabLoaded, pressSubmitInTab } from '../fixtures/tabs'
import { AutomationPage } from '../pages/automation'
import { BoardPage } from '../pages/board'
import { BrowserPage } from '../pages/browser'
import { ExplorePage } from '../pages/explore'
import { SettingsPage } from '../pages/settings'
import { Shell } from '../pages/shell'

/**
 * Automation (#154) against the mock ATS and the mock Jobright, with the fake agents:
 *
 * - Contoso's Explore row (a3) is saved, its employer link resolved (signed in), its description read from
 *   Jobright's summary (#148: the employer page is only a form), scored above 80, tailored by the unattended
 *   pipeline, and its form filled in a hidden tab with an AI draft, nothing attached and nothing submitted:
 *   Ready to submit. "Review & submit" approves it and opens the filled form; the test presses Submit and the
 *   confirmation records it as applied.
 * - The other Explore rows that share a title with the profile are read and skipped for too few requirements.
 * - A saved job whose apply link is a posting page (Huntgry never presses its Apply link) is tailored once,
 *   filled once, and lands in Needs you; another run does not touch it.
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents({ script: 'normal' }) })

const CONTOSO = 'Embedded Software Engineer'
const CONTOSO_ID = 'jobright:e2e0000000000000000000a3'
const WALLED = savedJob({
  id: 'pasted:e2e-walled',
  title: 'Payments Backend Engineer',
  company: 'Globex Walls',
  description: 'Globex Walls is hiring a Payments Backend Engineer.\n\nRequirements: Go, Python, TypeScript, PostgreSQL, AWS and Docker in production.'
})

const exists = (path: string) => access(path).then(() => true, () => false)

interface AutomationFile {
  candidates: Record<string, { step: string; failedStep?: string; error?: string; applicationId?: string; reasons: string[] }>
}
const readState = async (ws: string): Promise<AutomationFile> => JSON.parse(await readFile(join(ws, '.huntgry/automation.json'), 'utf8'))
const readLog = async (ws: string) =>
  (await readFile(join(ws, '.huntgry/automation-log.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { key: string; step: string; outcome: string; message: string })

/** Settings for the run: anytime, both sources, defaults otherwise (Match ≥ 80 with ≥ 4 requirements). */
async function automationSettings(userData: string): Promise<void> {
  const file = join(userData, 'settings.json')
  const settings = JSON.parse(await readFile(file, 'utf8'))
  settings.automation = { window: { mode: 'anytime' }, sources: { jobs: true, explore: true }, threshold: 80, minRequirements: 4 }
  await writeFile(file, JSON.stringify(settings, null, 2))
}

/** Settings → Connect Jobright, signed in on the mock (the employer links need it, #146). */
async function connectJobright(page: Page, app: { electronApp: import('@playwright/test').ElectronApplication }): Promise<void> {
  const shell = new Shell(page)
  await shell.goTo('settings')
  const settings = new SettingsPage(page)
  const signIn = app.electronApp.waitForEvent('window')
  await settings.jobrightButton('Connect Jobright').click()
  const win = await signIn
  await win.getByRole('link', { name: 'Sign in' }).click()
  await win.getByRole('button', { name: 'Sign in' }).click()
  await expect(settings.jobrightStatus('Connected')).toBeVisible({ timeout: 30_000 })
}

test('prepares a high-match Explore job up to Submit, skips thin matches, and leaves a walled job to the user', async ({ app, mock }) => {
  test.setTimeout(240_000)
  const ws = app.workspace!
  const agents = fakeAgents(app)
  const schema = (i: { args?: string[] }) => i.args![i.args!.indexOf('--json-schema') + 1] ?? ''
  const draftCalls = async () => (await agents.invocations()).filter((i) => i.mode === 'oneshot' && !schema(i).includes('"mappings"'))

  await automationSettings(app.userData)
  await connectJobright(app.window, app)
  // Explore's list is cached once the page opens; Automation reads the cache, it never fetches the list.
  const shell = new Shell(app.window)
  await shell.goTo('explore')
  await expect.poll(() => new ExplorePage(app.window).listedTitles()).toHaveLength(3)
  // A saved job whose link is a posting page: the fill stops there.
  await seedJobs(ws, [{ ...WALLED, url: `${mock.origin}/postings/employer/102` }])

  const automation = new AutomationPage(app.window)
  await automation.goto()
  await automation.runNow()

  // Contoso: every step, then Ready to submit.
  const card = automation.readyCard(CONTOSO)
  await expect(card).toBeVisible({ timeout: 180_000 })
  await expect(card).toContainText('Contoso Robotics')
  await expect(card).toContainText(/85|Match/)
  const ai = card.getByRole('list', { name: 'AI answers — check these' })
  await expect(ai).toContainText('AI draft')
  await expect(ai).toContainText('Fake draft: What interests you about this role?')

  // The walled job needs the user, at the filling step, with the page's reason.
  const walled = automation.needsYou('Payments Backend Engineer')
  await expect(walled).toBeVisible({ timeout: 120_000 })
  await expect(walled).toContainText('Filling the form')
  await expect.poll(async () => (await readState(ws)).candidates[WALLED.id]?.step).toBe('needs-you')

  // Thin matches: read, scored and skipped with the reason.
  await expect(automation.row(/Backend Engineer I/)).toBeVisible()
  await expect(automation.reason(/Backend Engineer I/)).toContainText(/requirement|below 80/)
  await automation.expectStep(/Backend Engineer I/, 'Skipped')

  // On disk: the state, one log line per step start and end, the prepared fill; nothing submitted, nothing applied.
  const state = await readState(ws)
  const contoso = state.candidates[CONTOSO_ID]
  expect(contoso).toMatchObject({ step: 'ready' })
  expect(state.candidates[WALLED.id]).toMatchObject({ step: 'needs-you', failedStep: 'filling' })
  const log = await readLog(ws)
  const steps = log.filter((e) => e.key === CONTOSO_ID).map((e) => `${e.step}:${e.outcome}`)
  for (const step of ['link', 'description', 'scoring', 'tailoring', 'filling']) {
    expect(steps).toContain(`${step}:start`)
    expect(steps.some((s) => s.startsWith(`${step}:`) && !s.endsWith(':start'))).toBe(true)
  }
  expect(log.some((e) => e.key === CONTOSO_ID && /Jobright's summary/.test(e.message))).toBe(true)
  const appId = contoso.applicationId!
  const prepared = JSON.parse(await readFile(join(ws, '.huntgry/automation/prepared', `${appId.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`), 'utf8'))
  // Nothing was attached during the unattended fill: the resume line waits for the user's open.
  expect(prepared.report.fields.find((f: { kind: string }) => f.kind === 'file')).toMatchObject({ outcome: 'to-upload' })
  expect(Object.values(prepared.drafts)).toEqual(['Fake draft: What interests you about this role?'])
  expect(await exists(mock.submissionFile)).toBe(false)
  expect(JSON.parse(await readFile(join(ws, appId, 'huntgry.json'), 'utf8')).status).toBe('generated')

  // The walled job was tailored once and filled once; another run leaves it alone.
  const tailoredRuns = async () => (await agents.runs()).length
  const runsBefore = await tailoredRuns()
  const walledFills = () => mock.requests.filter((r) => r === '/postings/employer/102').length
  const fillsBefore = walledFills()
  expect(log.filter((e) => e.key === WALLED.id && e.step === 'tailoring' && e.outcome === 'start')).toHaveLength(1)
  expect(log.filter((e) => e.key === WALLED.id && e.step === 'filling' && e.outcome === 'start')).toHaveLength(1)
  await expect(automation.runNowButton).toBeEnabled({ timeout: 30_000 })
  await automation.runNow()
  await expect(automation.runNowButton).toBeEnabled({ timeout: 60_000 })
  expect(await tailoredRuns()).toBe(runsBefore)
  expect(walledFills()).toBe(fillsBefore)
  expect((await readState(ws)).candidates[WALLED.id].step).toBe('needs-you')

  // The Board shows Contoso in "Ready to submit".
  await shell.goTo('board')
  const board = new BoardPage(app.window)
  await expect(board.column('submit')).toContainText(CONTOSO)
  await shell.goTo('automation')
  await expect(automation.heading).toBeVisible()

  // One click: approve, open the filled form (resume attached now), no new model call; the test presses Submit.
  const drafts = (await draftCalls()).length
  await automation.reviewAndSubmit(CONTOSO)
  await shell.expectActive('browser')
  const browser = new BrowserPage(app.window)
  await expectTabLoaded(app.electronApp, '/postings/apply-only')
  await browser.apply.expectStatus('Filled: review and submit')
  await expect(browser.apply.field('What interests you about this role?')).toContainText('AI draft')
  expect(await evaluateInTab<string>(app.electronApp, '/postings/apply-only', `document.querySelector('textarea').value`)).toBe(
    'Fake draft: What interests you about this role?'
  )
  expect(await evaluateInTab<string>(app.electronApp, '/postings/apply-only', `document.querySelector('#fn').value`)).toBe('Alex')
  // The resume is attached now, on the user's open.
  await expect
    .poll(() => evaluateInTab<string>(app.electronApp, '/postings/apply-only', `document.querySelector('#cv').files[0]?.name ?? ''`), { timeout: 20_000 })
    .toBe('resume.pdf')
  expect((await draftCalls()).length).toBe(drafts)
  expect(await exists(mock.submissionFile)).toBe(false)

  await pressSubmitInTab(app.electronApp, '/postings/apply-only')
  await expect.poll(() => exists(mock.submissionFile), { timeout: 20_000 }).toBe(true)
  await expect.poll(async () => (await readState(ws)).candidates[CONTOSO_ID].step, { timeout: 30_000 }).toBe('submitted')
  expect(JSON.parse(await readFile(join(ws, appId, 'huntgry.json'), 'utf8')).status).toBe('applied')
})
