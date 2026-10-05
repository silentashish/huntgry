import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
 * The review state is written to huntgry.json the way the pipeline writes it.
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents({ script: 'normal' }) })

const JOB = { company: 'Gate Co', role: 'Platform Engineer', jobId: 'GT-31' }
const FOLDER = 'platform-engineer/gate-co/gt-31'
const REASON = 'Apply: This result is Unreviewed: approve it on the Review page first.'

async function setReview(workspace: string, state: string): Promise<void> {
  const file = join(workspace, FOLDER, 'huntgry.json')
  const tracking = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
  tracking.review = { state, runId: '20261005-000000-aaaaaa', at: new Date().toISOString() }
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
  await setReview(app.workspace!, 'unreviewed')
  await expect(tailor.outputButton('Apply')).toBeDisabled()
  await expect(tailor.applyReason).toHaveText(REASON)

  const dashboard = new Dashboard(app.window)
  await shell.goTo('dashboard')
  await expect(dashboard.row(JOB.company).getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  await expect(dashboard.row(JOB.company)).toContainText('Unreviewed')
  const drawer = await dashboard.open(JOB.company)
  await expect(drawer.getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
  await dashboard.closeDrawer()

  // Approved on the Review page: every entry point allows Apply again.
  await setReview(app.workspace!, 'approved')
  await expect(dashboard.row(JOB.company).getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  await expect((await dashboard.open(JOB.company)).getByRole('button', { name: 'Apply in browser' })).toBeEnabled()
  await dashboard.closeDrawer()
})
