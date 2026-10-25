import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/servers/fixture'
import { ExplorePage } from '../pages/explore'
import { JobsPage } from '../pages/jobs'
import { SettingsPage } from '../pages/settings'
import { Shell } from '../pages/shell'

/**
 * Employer links for Jobright jobs (#146), against the mock Jobright on 127.0.0.1: its posting pages carry
 * Next.js data like jobright.ai's, and once the mock sign-in cookie is set (`/jobright/signin`) they give the
 * employer's posting (on the mock's other origin) as `applyLink`.
 */
test.use({ workspace: 'mocks' })

const ID = 'e2e0000000000000000000a1'
const jobFile = (workspace: string) => join(workspace, '.huntgry/jobs', `jobright-${ID}.json`)

test('connect Jobright once in Settings; added jobs link the employer posting and fetch it', async ({ app, mock }) => {
  const shell = new Shell(app.window)
  await shell.goTo('explore')
  const explore = new ExplorePage(app.window)
  await expect(explore.heading).toBeVisible()
  await expect.poll(() => explore.listedTitles()).toHaveLength(3)

  // Not connected: Explore says how to get employer links, and its button opens the Settings card.
  await expect(explore.connectHint).toBeVisible()
  await explore.connectHint.getByRole('button', { name: 'Connect Jobright' }).click()
  const settings = new SettingsPage(app.window)
  await expect(settings.heading).toBeVisible()
  await expect(settings.cardHeading('Jobright')).toBeInViewport()
  await expect(settings.jobrightStatus('Not connected')).toBeVisible()

  // Connect opens Jobright in a window on the job-board browser's session; signing in there closes it.
  const signIn = app.electronApp.waitForEvent('window')
  await settings.jobrightButton('Connect Jobright').click()
  const win = await signIn
  await win.getByRole('link', { name: 'Sign in' }).click()
  await win.getByRole('button', { name: 'Sign in' }).click()
  await expect(settings.jobrightStatus('Connected')).toBeVisible({ timeout: 30_000 })
  await expect(app.window.getByText(/Signed in\. Checked just now\./)).toBeVisible()
  await expect.poll(() => win.isClosed()).toBe(true)

  // Adding from Explore now saves the employer's posting as the link; the Jobright page stays the board link.
  await shell.goTo('explore')
  await expect(explore.heading).toBeVisible()
  await expect(explore.connectHint).toHaveCount(0)
  await explore.addButton('Software Engineer, New Grad').click()
  await expect(explore.addedButton('Software Engineer, New Grad')).toBeVisible({ timeout: 30_000 })
  const saved = JSON.parse(await readFile(jobFile(app.workspace!), 'utf8'))
  expect(saved).toMatchObject({
    id: `jobright:${ID}`,
    source: 'jobright',
    url: `${mock.altOrigin}/postings/employer/101`,
    boardUrl: `${mock.origin}/jobs/info/${ID}`
  })

  // Fetch full description reads the employer's page.
  await explore.addedButton('Software Engineer, New Grad').click()
  const jobs = new JobsPage(app.window)
  await expect(jobs.drawer).toBeVisible()
  await jobs.drawerButton('Fetch full description').click()
  await expect(jobs.drawer.getByText(/Initrode builds the scheduling platform/)).toBeVisible({ timeout: 30_000 })
  expect(mock.requests).toContain('/postings/employer/101')

  // Disconnect signs the job-board browser out: the next check says so, and a new add keeps Jobright's link.
  await jobs.closeDrawer()
  await shell.goTo('settings')
  await settings.jobrightButton('Disconnect').click()
  await expect(settings.jobrightStatus('Not connected')).toBeVisible()
  await settings.jobrightButton('Check sign-in').click()
  await expect(settings.jobrightStatus('Not connected')).toBeVisible({ timeout: 30_000 })
  await expect(app.window.getByText(/Checked just now/)).toBeVisible()
  await shell.goTo('explore')
  await expect(explore.connectHint).toBeVisible()
  await explore.addButton('Backend Engineer I').click()
  await expect(explore.addedButton('Backend Engineer I')).toBeVisible()
  const other = JSON.parse(await readFile(join(app.workspace!, '.huntgry/jobs', 'jobright-e2e0000000000000000000a2.json'), 'utf8'))
  expect(other.url).toBe(`${mock.origin}/jobs/info/e2e0000000000000000000a2`)
})

test("an employer page that is only an application form falls back to Jobright's summary (#148)", async ({ app, mock }, testInfo) => {
  const shell = new Shell(app.window)
  await shell.goTo('settings')
  const settings = new SettingsPage(app.window)
  const signIn = app.electronApp.waitForEvent('window')
  await settings.jobrightButton('Connect Jobright').click()
  const win = await signIn
  await win.getByRole('link', { name: 'Sign in' }).click()
  await win.getByRole('button', { name: 'Sign in' }).click()
  await expect(settings.jobrightStatus('Connected')).toBeVisible({ timeout: 30_000 })

  // Contoso's employer link is an ATS apply step: the form and nothing else.
  await shell.goTo('explore')
  const explore = new ExplorePage(app.window)
  await explore.addButton('Embedded Software Engineer').click()
  await expect(explore.addedButton('Embedded Software Engineer')).toBeVisible({ timeout: 30_000 })
  const file = join(app.workspace!, '.huntgry/jobs', 'jobright-e2e0000000000000000000a3.json')
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    url: `${mock.altOrigin}/postings/apply-only`,
    boardUrl: `${mock.origin}/jobs/info/e2e0000000000000000000a3`
  })

  await explore.addedButton('Embedded Software Engineer').click()
  const jobs = new JobsPage(app.window)
  await expect(jobs.drawer).toBeVisible()
  const before = mock.requests.length
  await jobs.drawerButton('Fetch full description').click()
  await expect(jobs.drawer.getByText(/Jobright's summary: Contoso Robotics is looking for/)).toBeVisible({ timeout: 40_000 })
  await expect(
    jobs.drawer.getByText("Description from Jobright's summary; the employer's page had only the application form.")
  ).toBeVisible()
  await expect(jobs.drawer.getByText(/## Must have/)).toBeVisible()
  // The employer's page was read first, then the Jobright page.
  const loaded = mock.requests.slice(before).filter((r) => r === '/postings/apply-only' || r.startsWith('/jobs/info/e2e0000000000000000000a3'))
  expect(loaded).toEqual(['/postings/apply-only', '/jobs/info/e2e0000000000000000000a3'])
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved).toMatchObject({ descriptionComplete: true, descriptionSource: 'jobright-summary', url: `${mock.altOrigin}/postings/apply-only` })
  expect(saved.description).not.toMatch(/First name/)
  // Fetch full description stays offered: the employer's page may have the posting later.
  await expect(jobs.drawerButton('Fetch full description')).toBeVisible()
  const png = testInfo.outputPath('jobright-summary-drawer.png')
  await app.window.screenshot({ path: png })
  await testInfo.attach('jobright-summary-drawer', { path: png, contentType: 'image/png' })
})

test('Connect works from Settings before Explore was ever opened (the list is fetched for a posting)', async ({ app, mock }) => {
  const shell = new Shell(app.window)
  await shell.goTo('settings')
  const settings = new SettingsPage(app.window)
  await expect(settings.jobrightStatus('Not connected')).toBeVisible()
  const listFetches = () => mock.requests.filter((r) => r.startsWith('/jobright/swan/mini-sites/list?') || r === '/jobright/README.md')
  expect(listFetches()).toEqual([])

  const signIn = app.electronApp.waitForEvent('window')
  await settings.jobrightButton('Connect Jobright').click()
  const win = await signIn
  // The list was fetched (from the API, #169) to find a posting, and the window opened on one.
  await expect.poll(() => win.url()).toContain('/jobs/info/')
  expect(listFetches()).toEqual(['/jobright/swan/mini-sites/list?position=0&count=500'])
  await win.getByRole('link', { name: 'Sign in' }).click()
  await win.getByRole('button', { name: 'Sign in' }).click()
  await expect(settings.jobrightStatus('Connected')).toBeVisible({ timeout: 30_000 })
})

test('Disconnect while a sign-in window is open closes it, and nothing marks the account connected again', async ({ app }) => {
  const shell = new Shell(app.window)
  await shell.goTo('settings')
  const settings = new SettingsPage(app.window)
  let signIn = app.electronApp.waitForEvent('window')
  await settings.jobrightButton('Connect Jobright').click()
  let win = await signIn
  await win.getByRole('link', { name: 'Sign in' }).click()
  await win.getByRole('button', { name: 'Sign in' }).click()
  await expect(settings.jobrightStatus('Connected')).toBeVisible({ timeout: 30_000 })

  // Reconnect opens the window again; leaving Settings and coming back shows a fresh card with Disconnect.
  signIn = app.electronApp.waitForEvent('window')
  await settings.jobrightButton('Reconnect').click()
  win = await signIn
  await shell.goTo('jobs')
  await shell.goTo('settings')
  await settings.jobrightButton('Disconnect').click()
  await expect(settings.jobrightStatus('Not connected')).toBeVisible()
  await expect.poll(() => win.isClosed()).toBe(true)
  // The sign-in cookie is gone: a check loads a signed-out page.
  await settings.jobrightButton('Check sign-in').click()
  await expect(app.window.getByText(/Checked just now/)).toBeVisible({ timeout: 30_000 })
  await expect(settings.jobrightStatus('Not connected')).toBeVisible()
})
