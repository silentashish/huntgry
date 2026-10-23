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
