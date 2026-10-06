import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFakeAgents } from '../fixtures/fake-agent'
import { expect, test } from '../fixtures/servers/fixture'
import { Dashboard } from '../pages/dashboard'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'

/**
 * #31 × #63: an unattended result stays out of Apply until it is approved on
 * the Review page, at every Apply entry point (the Tailor run's Apply button,
 * the Dashboard row, the application drawer), each with the reason; the
 * main-process gate in ApplyService.open() is covered by the unit tests.
 * The review state is recorded where main keeps it (userData), never in huntgry.json, which an
 * agent can write: a forged "approved" there unlocks nothing.
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents({ script: 'normal' }) })

const JOB = { company: 'Gate Co', role: 'Platform Engineer', jobId: 'GT-31' }
const FOLDER = 'platform-engineer/gate-co/gt-31'
const REASON = 'Apply: This result is Unreviewed: approve it on the Review page first.'

/**
 * Records the review state the way main does: in the review authority store under userData (outside
 * the workspace, which agents can write), then touches huntgry.json so the app's workspace watcher
 * re-lists the applications.
 */
async function setReview(userData: string, workspace: string, state: string): Promise<void> {
  const dir = join(userData, 'review', createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 32))
  await mkdir(dir, { recursive: true })
  const reviews = { [FOLDER]: { state, runId: '20261005-000000-aaaaaa', at: new Date().toISOString() } }
  await writeFile(join(dir, 'reviews.json'), JSON.stringify({ version: 1, reviews }, null, 2))
  await touch(workspace)
}

async function touch(workspace: string, review?: unknown): Promise<void> {
  const file = join(workspace, FOLDER, 'huntgry.json')
  const tracking = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
  if (review) tracking.review = review
  tracking.notes = `touched ${Date.now()}`
  await writeFile(file, JSON.stringify(tracking, null, 2))
}

test('an Unreviewed result blocks Apply with the reason on the Tailor run, the Dashboard row and the drawer', async ({ app, mock }) => {
  const shell = new Shell(app.window)
  await shell.goTo('tailor')
  const tailor = new TailorPage(app.window)
  await tailor.start({ jobUrl: `${mock.origin}/greenhouse/`, ...JOB, description: `# ${JOB.role}\n\n${JOB.company} is hiring. Go.` })
  await tailor.expectStatus('Waiting for you')
  await tailor.reply('Approved')
  await expect(tailor.outputLine(FOLDER)).toBeVisible()
  await expect(tailor.outputButton('Apply')).toBeEnabled()

  // The pipeline marks the result Unreviewed: the open run's Apply is disabled at once, with the reason.
  await setReview(app.userData, app.workspace!, 'unreviewed')
  await expect(tailor.outputButton('Apply')).toBeDisabled()
  await expect(tailor.applyReason).toHaveText(REASON)

  const dashboard = new Dashboard(app.window)
  await shell.goTo('dashboard')
  await expect(dashboard.row(JOB.company).getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  await expect(dashboard.row(JOB.company)).toContainText('Unreviewed')
  const drawer = await dashboard.open(JOB.company)
  await expect(drawer.getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
  await dashboard.closeDrawer()

  // An agent writing "approved" into the workspace's huntgry.json changes nothing.
  await touch(app.workspace!, { state: 'approved', runId: '20261005-000000-aaaaaa', at: new Date().toISOString() })
  // Give the watcher time to re-list (a forged state would show up by then).
  await app.window.waitForTimeout(1500)
  await expect(dashboard.row(JOB.company).getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  await expect(dashboard.row(JOB.company)).toContainText('Unreviewed')

  // Approved on the Review page (main records it): every entry point allows Apply again.
  await setReview(app.userData, app.workspace!, 'approved')
  await expect(dashboard.row(JOB.company).getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  await expect((await dashboard.open(JOB.company)).getByRole('button', { name: 'Apply in browser' })).toBeEnabled()
  await dashboard.closeDrawer()
})
