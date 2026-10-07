import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Preparer } from '../fixtures/app'
import { savedJob, seedJobs, seedQueue } from '../fixtures/queue'
import { seedResult, seedReviews } from '../fixtures/review'
import { expect, test } from '../fixtures/servers/fixture'
import { BoardPage } from '../pages/board'
import { Dashboard } from '../pages/dashboard'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'

/**
 * The Board (#85) on the `demo` workspace (five applications and one saved job, see
 * e2e/fixtures/workspaces/README.md) plus, seeded before launch: a queued job, a job whose run waits
 * for a reply, an Unreviewed unattended result, a dismissed job, an application archived two days
 * ago and one archived eight days ago. The mock server (fixtures/servers) serves the posting a link
 * is pasted for. Every move is asserted on disk.
 */

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()

const QUEUED = savedJob({ id: 'pasted:e2e-85-queued', title: 'Site Reliability Engineer', company: 'Hooli' })
const REPLY = savedJob({ id: 'pasted:e2e-85-reply', title: 'Machine Learning Engineer', company: 'Pied Piper' })
const DISMISSED = savedJob({
  id: 'pasted:e2e-85-dismissed',
  title: 'Solutions Architect',
  company: 'Massive Dynamic',
  dismissed: true,
  dismissedAt: daysAgo(1)
})
const REVIEW = { folder: 'security-engineer/stark/e2e-85-review', runId: '20261006-080000-aaaaaa' }
const ARCHIVED = {
  recent: { folder: 'qa-engineer/lexcorp/e2e-85-recent', title: 'QA Engineer', at: daysAgo(2) },
  old: { folder: 'support-engineer/oscorp/e2e-85-old', title: 'Support Engineer', at: daysAgo(8) }
}

/** The demo's own cards, by title: the job description's first heading, or the saved job's title. */
const DEMO = {
  acme: 'Senior Software Engineer',
  globex: 'Backend Engineer, Reporting',
  initech: 'Platform Engineer',
  umbrella: 'Data Engineer, Streaming',
  wayne: 'Frontend Engineer',
  savedJob: 'Staff Backend Engineer'
}

const board: Preparer = {
  async prepare({ sandbox, workspace }) {
    const ws = workspace!
    await seedJobs(ws, [QUEUED, REPLY, DISMISSED])
    await seedQueue(ws, [
      { job: QUEUED, status: 'queued' },
      { job: REPLY, status: 'needs-reply', runId: '20261006-090000-bbbbbb' }
    ])
    await seedResult(ws, REVIEW.folder, { role: 'Security Engineer', company: 'Stark', runId: REVIEW.runId })
    await seedReviews(sandbox.userData, ws, { [REVIEW.folder]: { state: 'unreviewed', runId: REVIEW.runId } })
    for (const a of Object.values(ARCHIVED)) {
      const dir = join(ws, ...a.folder.split('/'))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'job-description.md'), `# ${a.title}\n\nSeeded by e2e.\n`)
      await writeFile(join(dir, 'huntgry.json'), JSON.stringify({ status: 'archived', notes: '', archivedAt: a.at }, null, 2))
    }
  }
}

test.use({ workspace: 'demo', prepare: board })

const tracking = async (workspace: string, id: string) =>
  JSON.parse(await readFile(join(workspace, id, 'huntgry.json'), 'utf8')) as Record<string, unknown>
const jobsDir = (workspace: string) => join(workspace, '.huntgry/jobs')
const readJob = async (workspace: string, file: string) => JSON.parse(await readFile(join(jobsDir(workspace), file), 'utf8'))

async function openBoard(app: { window: import('@playwright/test').Page }): Promise<BoardPage> {
  await new Shell(app.window).goTo('board')
  const page = new BoardPage(app.window)
  await expect(page.heading).toBeVisible()
  await expect(page.card(DEMO.acme)).toBeVisible()
  return page
}

test.describe('board columns', () => {
  test('every job is one card in the column of its stage', async ({ app }) => {
    const page = await openBoard(app)
    await page.expectIn('todo', DEMO.savedJob)
    await page.expectIn('tailoring', 'Site Reliability Engineer')
    await expect(page.card('Site Reliability Engineer')).toContainText('Queued')
    await page.expectIn('review', 'Machine Learning Engineer')
    await expect(page.card('Machine Learning Engineer')).toContainText('Needs your reply')
    await page.expectIn('review', 'Security Engineer')
    await expect(page.card('Security Engineer')).toContainText('Unreviewed')
    await page.expectIn('ready', DEMO.acme)
    await page.expectIn('ready', DEMO.umbrella)
    await page.expectIn('applied', DEMO.globex)
    await expect(page.card(DEMO.globex)).toContainText('applied 2026-09-20')
    await page.expectIn('interviewing', DEMO.initech)
    await page.expectIn('rejected', DEMO.wayne)
    await expect(page.cards('offer')).toHaveCount(0)
    await expect(page.column('offer')).toContainText('Nothing here')

    // Archived keeps a week: the result archived two days ago and the job dismissed yesterday, not the one from eight days ago.
    await expect.poll(() => page.titles('archived')).toEqual(['Solutions Architect', ARCHIVED.recent.title])
    await expect(page.card(ARCHIVED.old.title)).toHaveCount(0)
    await expect(page.column('archived')).toContainText('Cards leave the board 7 days after they are archived. 1 older not shown.')

    // Each column header counts its cards.
    await expect(page.column('ready').getByLabel('2 cards')).toBeVisible()
    await expect(page.column('review').getByLabel('2 cards')).toBeVisible()
  })

  test('a card that left the board is still on the Dashboard and on Jobs', async ({ app }) => {
    await openBoard(app)
    await new Shell(app.window).goTo('dashboard')
    const dash = new Dashboard(app.window)
    await dash.statusFilter.click()
    await app.window.getByRole('option', { name: 'Archived' }).click()
    await app.window.keyboard.press('Escape')
    await dash.expectCompanies(['Lexcorp', 'Oscorp'])

    await new Shell(app.window).goTo('jobs')
    const jobs = new JobsPage(app.window)
    await jobs.show('Dismissed')
    await expect(jobs.jobTitle('Solutions Architect')).toBeVisible()
  })
})

test.describe('adding and moving cards', () => {
  test('a posting link pasted into To do is saved and shows up in To do and on Jobs', async ({ app, mock }) => {
    const page = await openBoard(app)
    await expect(page.addButton).toBeDisabled()
    await page.addLink(`${mock.origin}/postings/lever-style`)
    await page.expectIn('todo', 'Software Engineer')
    await expect(page.card('Software Engineer')).toContainText('Acme · Denver, CO, US')
    await expect(page.linkInput).toHaveValue('')

    const files = (await readdir(jobsDir(app.workspace!))).filter((n) => n.startsWith('url-'))
    const saved = await Promise.all(files.map((f) => readJob(app.workspace!, f)))
    expect(saved.find((j) => j.url === `${mock.origin}/postings/lever-style`)).toMatchObject({
      source: 'url',
      title: 'Software Engineer',
      company: 'Acme'
    })

    await new Shell(app.window).goTo('jobs')
    const jobs = new JobsPage(app.window)
    await jobs.show('All')
    await expect(jobs.jobTitle('Software Engineer')).toBeVisible()
  })

  test('a link the loader cannot read leaves an error in To do and adds nothing', async ({ app }) => {
    const page = await openBoard(app)
    await page.addLink('http://10.0.0.1/careers/1')
    await expect(page.column('todo').getByRole('alert')).toBeVisible()
    await expect(page.cards('todo')).toHaveCount(1)
  })

  test('Move to writes the status; Archived records when, and leaving it clears that', async ({ app }) => {
    const page = await openBoard(app)
    const acme = 'software-engineer/acme/acme-4821'
    expect(await page.moveTargets(DEMO.acme)).toEqual(['Applied', 'Interviewing', 'Offer', 'Rejected', 'Archived'])

    await page.moveTo(DEMO.acme, 'applied')
    await expect.poll(async () => (await tracking(app.workspace!, acme)).status).toBe('applied')
    expect((await tracking(app.workspace!, acme)).appliedAt).toBe(new Date().toISOString().slice(0, 10))

    await page.moveTo(DEMO.acme, 'archived')
    await expect.poll(async () => (await tracking(app.workspace!, acme)).status).toBe('archived')
    const archivedAt = Date.parse(String((await tracking(app.workspace!, acme)).archivedAt))
    expect(Math.abs(Date.now() - archivedAt)).toBeLessThan(5 * 60 * 1000)
    // Newest first: the card just archived leads the column.
    await expect.poll(async () => (await page.titles('archived'))[0]).toBe(DEMO.acme)

    await page.moveTo(DEMO.acme, 'interviewing')
    await expect.poll(async () => (await tracking(app.workspace!, acme)).status).toBe('interviewing')
    expect((await tracking(app.workspace!, acme)).archivedAt).toBeUndefined()
  })

  test('cards are dragged between columns; columns that do not take the card ignore the drop', async ({ app }) => {
    const page = await openBoard(app)
    await page.drag(DEMO.umbrella, 'rejected')
    await page.expectIn('rejected', DEMO.umbrella)
    await expect.poll(async () => (await tracking(app.workspace!, 'data-engineer/umbrella/umb-12')).status).toBe('rejected')

    // Tailoring is run by the queue: a To do job dropped there stays in To do.
    await page.drag(DEMO.savedJob, 'tailoring')
    await page.expectIn('todo', DEMO.savedJob)
    await expect(page.cards('tailoring')).toHaveCount(1)
  })

  test('archiving a To do job dismisses it; moving it back restores it', async ({ app }) => {
    const page = await openBoard(app)
    expect(await page.moveTargets(DEMO.savedJob)).toEqual(['Archived'])
    await page.moveTo(DEMO.savedJob, 'archived')
    await expect.poll(async () => (await readJob(app.workspace!, 'hiring.cafe-demo-1.json')).dismissed).toBe(true)
    expect(Date.parse((await readJob(app.workspace!, 'hiring.cafe-demo-1.json')).dismissedAt)).not.toBeNaN()
    await expect(page.cards('todo')).toHaveCount(0)

    await page.moveTo(DEMO.savedJob, 'todo')
    await expect.poll(async () => (await readJob(app.workspace!, 'hiring.cafe-demo-1.json')).dismissed).toBe(false)
    expect((await readJob(app.workspace!, 'hiring.cafe-demo-1.json')).dismissedAt).toBeUndefined()
  })

  test('cards run by the queue and Review have no Move to; a result waiting for review can only be rejected or archived', async ({
    app
  }) => {
    const page = await openBoard(app)
    for (const title of ['Site Reliability Engineer', 'Machine Learning Engineer']) {
      await expect(page.card(title).getByRole('button', { name: /^Move / })).toHaveCount(0)
    }
    expect(await page.moveTargets('Security Engineer')).toEqual(['Rejected', 'Archived'])
  })
})

test.describe('details on the board', () => {
  test('clicking a card opens its drawer; Review opens the result on the Review page', async ({ app }) => {
    const page = await openBoard(app)
    const shell = new Shell(app.window)

    await page.card(DEMO.globex).getByText(DEMO.globex, { exact: true }).click()
    const dash = new Dashboard(app.window)
    await expect(dash.drawer).toBeVisible()
    await expect(dash.drawer.getByRole('heading', { level: 2 })).toContainText('Globex')
    await dash.closeDrawer()

    await page.card(DEMO.savedJob).getByText(DEMO.savedJob, { exact: true }).click()
    const jobs = new JobsPage(app.window)
    await expect(jobs.drawer).toBeVisible()
    await expect(jobs.drawer).toContainText('Initech is looking for a Staff Backend Engineer')
    await jobs.closeDrawer()
    await shell.expectActive('board')

    await page.card('Security Engineer').getByRole('button', { name: 'Review', exact: true }).click()
    await expect(app.window.getByRole('heading', { name: 'Review', level: 2 })).toBeVisible()
  })
})
