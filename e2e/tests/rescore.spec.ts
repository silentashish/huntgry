import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Preparer } from '../fixtures/app'
import { installFakeAgents } from '../fixtures/fake-agent'
import { BoardPage } from '../pages/board'
import { Shell } from '../pages/shell'
import { pastedFolder, TailorPage } from '../pages/tailor'

/**
 * #151: when a run's turn builds a resume, main scores it against the job next to the master
 * profile and keeps the numbers in the application's huntgry.json; the Board card, the drawer and
 * Review show them. The demo profile has Go and PostgreSQL, not Kubernetes; the fake agent's resume
 * names Go and TypeScript only.
 */

const PASTED = {
  description: '# Staff Engineer\n\nAcme Corp is hiring a Staff Engineer for its platform team. Go, PostgreSQL, Kubernetes.',
  company: 'Acme Corp',
  role: 'Staff Engineer'
}
const LINE = 'Profile fit 67 · Resume 33 (50% surfaced)'

const fakeAgents: Preparer = {
  prepare: ({ sandbox }) => installFakeAgents(sandbox, { script: 'normal' })
}

test.use({ workspace: 'demo', prepare: fakeAgents })

test('a finished run is re-scored: profile fit vs resume coverage on the card, the drawer and Review', async ({ app }, testInfo) => {
  const shell = new Shell(app.window)
  await shell.goTo('tailor')
  const tailor = new TailorPage(app.window)
  await tailor.start(PASTED)
  await tailor.expectStatus('Finished', 30_000)

  // Stored by main in the application's tracking data; the skill's files are only read.
  const folder = join(app.workspace!, pastedFolder(PASTED))
  const tracking = JSON.parse(await readFile(join(folder, 'huntgry.json'), 'utf8'))
  expect(tracking.match).toMatchObject({
    profileFit: 67,
    resumeCoverage: 33,
    surfaced: 50,
    requirements: 3,
    leftOut: ['PostgreSQL'],
    resumeFrom: 'resume_data.json',
    source: 'description'
  })

  await shell.goTo('board')
  const board = new BoardPage(app.window)
  const card = await board.application('Acme Corp')
  await card.hover()
  await expect(card.getByText(LINE, { exact: true })).toBeVisible()
  const cardPng = testInfo.outputPath('rescore-card.png')
  await card.screenshot({ path: cardPng })
  await testInfo.attach('rescore-card', { path: cardPng, contentType: 'image/png' })

  const drawer = await board.openApplication('Acme Corp')
  const box = drawer.getByTestId('resume-match')
  await expect(box).toContainText(LINE)
  await expect(box.getByLabel('Left out of the resume')).toContainText('PostgreSQL')
  const drawerPng = testInfo.outputPath('rescore-drawer.png')
  await app.window.screenshot({ path: drawerPng })
  await testInfo.attach('rescore-drawer', { path: drawerPng, contentType: 'image/png' })
  await board.closeDrawer()

  await shell.goTo('review')
  await app.window.getByRole('button', { name: /Staff Engineer · Acme Corp/ }).first().click()
  await expect(app.window.getByTestId('resume-match')).toContainText(LINE)
  const reviewPng = testInfo.outputPath('rescore-review.png')
  await app.window.screenshot({ path: reviewPng })
  await testInfo.attach('rescore-review', { path: reviewPng, contentType: 'image/png' })
})
