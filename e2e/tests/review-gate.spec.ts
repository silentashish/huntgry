import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFakeAgents } from '../fixtures/fake-agent'
import { expect, test } from '../fixtures/servers/fixture'
import { BoardPage } from '../pages/board'
import { Shell } from '../pages/shell'
import { pastedFolder, TailorPage } from '../pages/tailor'

/**
 * #31 × #63: an unattended result stays out of Apply until it is approved on
 * the Review page, at every Apply entry point (the Tailor run's Apply button,
 * the Board card, the application drawer), each with the reason; the
 * main-process gate in ApplyService.open() is covered by the unit tests.
 * The review state is recorded where main keeps it (userData), never in huntgry.json, which an
 * agent can write: a forged "approved" there unlocks nothing.
 */
test.use({ workspace: 'mocks', prepare: withFakeAgents({ script: 'normal' }) })

const JOB = { company: 'Gate Co', role: 'Platform Engineer' }
const DESCRIPTION = `# ${JOB.role}\n\n${JOB.company} is hiring a Platform Engineer for its core team. Go.`
// The pasted job's folder (its job id hashes the posting URL, which holds the mock server's port).
let FOLDER = ''
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

test('an Unreviewed result blocks Apply with the reason on the Tailor run, the Board card and the drawer', async ({ app, mock }) => {
  const shell = new Shell(app.window)
  await shell.goTo('tailor')
  const tailor = new TailorPage(app.window)
  const job = { jobUrl: `${mock.origin}/greenhouse/`, ...JOB, description: DESCRIPTION }
  FOLDER = pastedFolder(job)
  await tailor.start(job)
  await tailor.expectStatus('Finished', 30_000)
  await expect(tailor.outputLine(FOLDER)).toBeVisible()

  // Every result goes through the verify gate (#158): the Tailor-page run's result is Unreviewed, Apply is
  // disabled, with the reason.
  await expect(tailor.outputButton('Apply')).toBeDisabled()
  await expect(tailor.applyReason).toHaveText(REASON)

  // On the Board (#161): the card waits in Needs review with no Apply, and the drawer's Apply is disabled.
  const board = new BoardPage(app.window)
  await shell.goTo('board')
  const card = await board.application(JOB.company)
  await expect(card).toContainText('Unreviewed')
  await expect(card.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0)
  await expect(board.column('review').locator('article[data-kind="application"]')).toHaveCount(1)
  const drawer = await board.openApplication(JOB.company)
  await expect(drawer.getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
  await board.closeDrawer()

  // An agent writing "approved" into the workspace's huntgry.json changes nothing.
  await touch(app.workspace!, { state: 'approved', runId: '20261005-000000-aaaaaa', at: new Date().toISOString() })
  // Give the watcher time to re-list (a forged state would show up by then).
  await app.window.waitForTimeout(1500)
  await expect(card).toContainText('Unreviewed')
  await expect((await board.openApplication(JOB.company)).getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
  await board.closeDrawer()

  // Approved on the Review page (main records it): every entry point allows Apply again.
  await setReview(app.userData, app.workspace!, 'approved')
  await expect(card).toContainText('Approved')
  await expect(card.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  await expect((await board.openApplication(JOB.company)).getByRole('button', { name: 'Apply in browser' })).toBeEnabled()
  await board.closeDrawer()
})
