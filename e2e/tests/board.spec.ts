import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Preparer } from '../fixtures/app'
import { appliedBacklog, seedApplications } from '../fixtures/board'
import { savedJob, seedJobs, seedQueue } from '../fixtures/queue'
import { seedResult, seedReviews } from '../fixtures/review'
import { expect, test } from '../fixtures/servers/fixture'
import { BoardPage } from '../pages/board'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'
import { openedPaths, stubOpenPath } from '../pages/tailor'

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
  // Cards of past weeks start folded (#160); these tests look at every card.
  await page.openAllWeeks()
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
    // An empty column is a narrow rail with its name and 0 (#160).
    await expect(page.cards('offer')).toHaveCount(0)
    await expect(page.column('offer').getByLabel('0 cards', { exact: true })).toBeVisible()
    expect((await page.column('offer').boundingBox())!.width).toBeLessThan(60)

    // Archived keeps a week: the result archived two days ago and the job dismissed yesterday, not the one from eight days ago.
    await expect.poll(() => page.titles('archived')).toEqual(['Solutions Architect', ARCHIVED.recent.title])
    await expect(page.card(ARCHIVED.old.title)).toHaveCount(0)
    await expect(page.column('archived')).toContainText('Cards leave the board 7 days after they are archived. 1 older not shown.')

    // Each card carries the Scent ring (#110): the job's score against the profile, or a check for a result with no saved job.
    // The saved job is from an earlier week, so its card is compact (#160) until hovered.
    await page.card(DEMO.savedJob).hover()
    await expect(page.card(DEMO.savedJob).getByRole('img', { name: /^Scent \d+ of 100$/ })).toBeVisible()
    await expect(page.card(DEMO.umbrella).getByRole('img', { name: 'Tailored' })).toBeVisible()

    // Each column header counts its cards.
    await expect(page.column('ready').getByLabel('2 cards', { exact: true })).toBeVisible()
    await expect(page.column('review').getByLabel('2 cards', { exact: true })).toBeVisible()
  })

  test('a card that left the board comes back with "Show older" in Archived, and is still on Jobs', async ({ app }) => {
    const page = await openBoard(app)
    // The Dashboard table's Archived filter listed every archived application; Archived does now, when asked (#161).
    const archived = page.column('archived')
    await expect(archived).toContainText('1 older not shown.')
    await archived.getByRole('button', { name: 'Show 1 older' }).click()
    await page.openAllWeeks('archived')
    await expect.poll(() => page.titles('archived')).toEqual(['Solutions Architect', ARCHIVED.recent.title, ARCHIVED.old.title])
    await expect(archived).toContainText('Every archived card, however old.')
    // Search finds it too, as the table's search did with Archived picked.
    await page.search.fill('Oscorp')
    await expect.poll(() => page.titles('archived')).toEqual([ARCHIVED.old.title])
    await page.search.fill('')
    await archived.getByRole('button', { name: 'Only the last 7 days' }).click()
    await expect(page.card(ARCHIVED.old.title)).toHaveCount(0)

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
    // The menu shows the card's own column ticked, as a disabled item, above the ones it can go to.
    await page.openMenu(DEMO.acme)
    await expect(page.currentColumnItem('ready')).toBeDisabled()
    await app.window.keyboard.press('Escape')
    expect(await page.moveTargets(DEMO.acme)).toEqual(['Applied', 'Interviewing', 'Offer', 'Rejected', 'Archive'])

    await page.moveTo(DEMO.acme, 'applied')
    await expect.poll(async () => (await tracking(app.workspace!, acme)).status).toBe('applied')
    expect((await tracking(app.workspace!, acme)).appliedAt).toBe(new Date().toISOString().slice(0, 10))

    await page.moveTo(DEMO.acme, 'archived', 'Archive')
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
    expect(await page.moveTargets(DEMO.savedJob)).toEqual(['Dismiss job'])
    await page.moveTo(DEMO.savedJob, 'archived', 'Dismiss job')
    await expect.poll(async () => (await readJob(app.workspace!, 'hiring.cafe-demo-1.json')).dismissed).toBe(true)
    expect(Date.parse((await readJob(app.workspace!, 'hiring.cafe-demo-1.json')).dismissedAt)).not.toBeNaN()
    await expect(page.cards('todo')).toHaveCount(0)

    await page.moveTo(DEMO.savedJob, 'todo')
    // Restored today, the saved job (fetched weeks ago) is in This week (#160).
    await expect(page.week('todo', 'This week').getByRole('article', { name: DEMO.savedJob, exact: true })).toBeVisible()
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
    expect(await page.moveTargets('Security Engineer')).toEqual(['Rejected', 'Archive'])
  })
})

test.describe('details on the board', () => {
  test('clicking a card opens its drawer; Review opens the result on the Review page', async ({ app }) => {
    const page = await openBoard(app)
    const shell = new Shell(app.window)

    await page.card(DEMO.globex).getByText(DEMO.globex, { exact: true }).click()
    await expect(page.drawer).toBeVisible()
    await expect(page.drawer.getByRole('heading', { level: 2 })).toContainText('Globex')
    await page.closeDrawer()

    await page.card(DEMO.savedJob).hover()
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

/**
 * What the Dashboard table did, on the Board (#161): every row action is on the card or in the
 * application drawer it opens, and the table's search has its home above the columns.
 */
test.describe('applications on the board (#161)', () => {
  test('search narrows the board by company, role, job title and notes', async ({ app }) => {
    const page = await openBoard(app)
    await page.search.fill('globex')
    await expect.poll(() => page.titles('applied')).toEqual([DEMO.globex])
    await expect(page.cards('ready')).toHaveCount(0)
    await page.search.fill('Streaming')
    await expect.poll(() => page.titles('ready')).toEqual([DEMO.umbrella])
    // Wayne's notes mention the take-home.
    await page.search.fill('take-home')
    await page.openAllWeeks()
    await expect.poll(() => page.titles('rejected')).toEqual([DEMO.wayne])
    await page.search.fill('no such application')
    await expect(app.window.getByRole('article')).toHaveCount(0)
    await app.window.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(page.search).toHaveValue('')
    await expect(page.card(DEMO.acme)).toBeVisible()
  })

  test('the drawer opens the resume, the cover letter, the posting and the folder', async ({ app }) => {
    const page = await openBoard(app)
    await stubOpenPath(app.electronApp)
    const id = 'platform-engineer/initech/init-9'
    const drawer = await page.openApplication('Initech')

    await drawer.getByRole('button', { name: 'Open resume', exact: true }).click()
    await drawer.getByRole('button', { name: 'Open cover letter' }).click()
    await drawer.getByRole('button', { name: 'Show in Finder' }).click()
    await expect
      .poll(() => openedPaths(app.electronApp))
      .toEqual([join(app.workspace!, id, 'resume.pdf'), join(app.workspace!, id, 'cover.pdf'), join(app.workspace!, id)])

    // The build result and the tracking the row showed.
    await expect(drawer.getByText('ATS checks passed')).toBeVisible()
    await expect(drawer.getByLabel('Applied on')).toHaveValue('2026-09-22')

    // The posting opens in the in-app browser.
    await drawer.getByRole('button', { name: 'Job posting' }).click()
    await new Shell(app.window).expectActive('browser')
  })

  test('the status dropdown writes huntgry.json; "Applied" stamps today, and the card changes column', async ({ app }) => {
    const page = await openBoard(app)
    const id = 'software-engineer/acme/acme-4821'
    expect(await tracking(app.workspace!, id)).toEqual({ status: 'generated', notes: '' })
    const drawer = await page.openApplication('Acme')

    // The app stamps the UTC date at write time; take it before and after so a run across UTC midnight accepts either day.
    const utcDate = () => new Date().toISOString().slice(0, 10)
    const before = utcDate()
    await page.pick(drawer.getByRole('combobox', { name: 'Status' }), 'Applied')
    const after = utcDate()
    await expect.poll(() => tracking(app.workspace!, id)).toMatchObject({ status: 'applied', notes: '' })
    const written = await tracking(app.workspace!, id)
    expect(Object.keys(written).sort()).toEqual(['appliedAt', 'notes', 'status', 'statusChangedAt'])
    expect([before, after]).toContain(written.appliedAt)
    await expect(drawer.getByLabel('Applied on')).toHaveValue(written.appliedAt as string)
    await page.closeDrawer()
    await page.search.fill('')
    await page.expectIn('applied', DEMO.acme)

    // Notes are written when the field loses focus, and are searchable right away.
    const again = await page.openApplication('Acme')
    await again.getByLabel('Notes').fill('Recruiter: Dana.')
    await again.getByLabel('Notes').blur()
    await expect.poll(() => tracking(app.workspace!, id)).toMatchObject({ notes: 'Recruiter: Dana.' })
    await page.closeDrawer()
    await page.search.fill('Dana')
    await expect.poll(() => page.titles('applied')).toEqual([DEMO.acme])
  })

  test('the build badge and review state are on the card and in the drawer; Apply says why it cannot start', async ({ app }) => {
    const page = await openBoard(app)
    // Build results on the cards: ok, failed, missing; the review state of an unattended result.
    await expect(page.card(DEMO.acme)).toContainText('ATS passed')
    await expect(page.card(DEMO.globex)).toContainText('Build failed')
    await expect(page.card(DEMO.umbrella)).toContainText('No report')
    await expect(page.card('Security Engineer')).toContainText('Unreviewed')

    // Ready to apply: Acme's card has Apply; Umbrella's (no resume.pdf) has none.
    await expect(page.card(DEMO.acme).getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
    await expect(page.card(DEMO.umbrella).getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0)

    // The drawer: the build report, no resume to open, Apply disabled with the reason.
    const umbrella = await page.openApplication('Umbrella')
    await expect(umbrella.getByText('No build report')).toBeVisible()
    await expect(umbrella.getByRole('button', { name: 'Open cover letter' })).toHaveCount(0)
    const apply = umbrella.getByRole('button', { name: 'Apply in browser' })
    await expect(apply).toBeDisabled()
    await apply.hover({ force: true })
    await expect(page.tooltip('No resume.pdf yet: build the resume in Tailor first.')).toBeVisible()
    await page.closeDrawer()

    // An unattended result: its review state, and Open in Review.
    const stark = await page.openApplication('Stark')
    await expect(stark.getByText('Unreviewed', { exact: true })).toBeVisible()
    await expect(stark.getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
    await stark.getByText('Open in Review').click()
    await expect(app.window.getByRole('heading', { name: 'Review', level: 2 })).toBeVisible()
  })

  test('adding the posting URL in the drawer unblocks Apply', async ({ app }) => {
    const page = await openBoard(app)
    const drawer = await page.openApplication('Wayne')
    await expect(drawer.getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
    await expect(drawer.getByRole('button', { name: 'Job posting' })).toHaveCount(0)
    await drawer.getByLabel('Job posting URL').fill('https://jobs.example.com/wayne/3')
    await drawer.getByLabel('Job posting URL').blur()
    await expect(drawer.getByRole('button', { name: 'Apply in browser' })).toBeEnabled()
    await expect.poll(() => tracking(app.workspace!, 'frontend-engineer/wayne/wy-3')).toMatchObject({
      jobUrl: 'https://jobs.example.com/wayne/3'
    })
  })
})

/**
 * 57 Applied applications, 8 a week over 8 weeks (#160), a Rejected one from 500 days ago and a
 * saved Jobright job, on top of the board above.
 */
const JOBRIGHT = savedJob({ id: 'jobright:e2e-160', source: 'jobright', title: 'Growth Engineer', company: 'Hooli' })
const backlog: Preparer = {
  async prepare(ctx) {
    await board.prepare(ctx)
    await seedApplications(ctx.workspace!, appliedBacklog(57, 8))
    await seedApplications(ctx.workspace!, [
      { folder: 'old-engineer/old-co/old-1', title: 'Old role', status: 'rejected', at: new Date(Date.now() - 500 * DAY) }
    ])
    await seedJobs(ctx.workspace!, [JOBRIGHT])
  }
}

/** The backlog's application folder for "Applied role <n>". */
const backlogFolder = (n: number) => {
  const id = String(n).padStart(2, '0')
  return `backlog-engineer/company-${id}/backlog-${id}`
}

test.describe('weeks, rails and search (#160)', () => {
  test.use({ prepare: backlog })

  async function openBacklog(app: { window: import('@playwright/test').Page }): Promise<BoardPage> {
    await new Shell(app.window).goTo('board')
    const page = new BoardPage(app.window)
    await expect(page.week('applied', 'This week')).toBeVisible()
    return page
  }

  test('past weeks are folded with their counts, open as compact cards, and stay as left after a restart', async ({ app }) => {
    let page = await openBacklog(app)
    const weeks = await page.weeks('applied')
    expect(weeks.slice(0, 2)).toEqual(['This week', 'Last week'])
    expect(weeks).toHaveLength(8)
    await expect(page.column('applied').getByLabel('58 cards', { exact: true })).toBeVisible()

    // This week is open with full cards; Last week shows its header and count only.
    const thisWeek = page.week('applied', 'This week')
    await expect(page.weekToggle('applied', 'This week')).toHaveAttribute('aria-expanded', 'true')
    await expect(thisWeek.getByRole('article', { name: 'Applied role 01' })).not.toHaveAttribute('data-compact')
    await expect(page.weekToggle('applied', 'Last week')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.weekToggle('applied', 'Last week')).toHaveAccessibleName('Last week, 8 cards')
    await expect(page.week('applied', 'Last week').getByRole('article')).toHaveCount(0)

    // Opened, a past week lists its cards newest first, one line each; hover shows the full card.
    await page.weekToggle('applied', 'Last week').click()
    const lastWeek = page.week('applied', 'Last week').getByRole('article')
    await expect(lastWeek).toHaveCount(8)
    expect(await lastWeek.evaluateAll((cs) => cs.map((c) => c.getAttribute('aria-label')))).toEqual(
      Array.from({ length: 8 }, (_, i) => `Applied role ${String(9 + i).padStart(2, '0')}`)
    )
    const card = page.card('Applied role 10')
    await expect(card).toHaveAttribute('data-compact', 'true')
    await expect(card.getByText('Company 10 · Applied role 10')).toBeVisible()
    await expect(card.getByText('No report')).toBeHidden()
    await card.hover()
    await expect(card.getByText('No report')).toBeVisible()
    await expect(card.getByText('Company 10 · Applied role 10')).toBeHidden()

    // The page does not grow with the cards: the column scrolls inside itself.
    expect(await app.window.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)

    // Fold this week, and open a week from more than a year ago; after a restart all three choices hold.
    await page.weekToggle('applied', 'This week').click()
    await expect(thisWeek.getByRole('article')).toHaveCount(0)
    const oldWeek = (await page.weeks('rejected')).at(-1)!
    expect(oldWeek).toMatch(/\d{4}/)
    await page.weekToggle('rejected', oldWeek).click()
    await expect(page.card('Old role')).toBeVisible()
    await app.relaunch()
    page = await openBacklog(app)
    await expect(page.weekToggle('applied', 'This week')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.week('applied', 'Last week').getByRole('article')).toHaveCount(8)
    await expect(page.week('rejected', oldWeek).getByRole('article', { name: 'Old role' })).toBeVisible()
    // Other columns keep their own state: Ready to apply's week is still open.
    await expect(page.weekToggle('ready', 'This week')).toHaveAttribute('aria-expanded', 'true')
  })

  test('cards of a past week move with Move to and by drag, also onto an empty column rail', async ({ app }) => {
    const page = await openBacklog(app)
    await expect(page.column('offer').getByLabel('0 cards', { exact: true })).toBeVisible()
    await page.openAllWeeks('applied')

    // Move to an empty column (its rail), from a compact card of last week. The card just moved
    // lands in This week, open and full, without opening any folded week to find it.
    await page.openMenu('Applied role 12')
    await app.window.getByRole('menuitem', { name: 'Offer', exact: true }).click()
    const moved = page.week('offer', 'This week').getByRole('article', { name: 'Applied role 12', exact: true })
    await expect(moved).toBeVisible()
    await expect(moved).not.toHaveAttribute('data-compact')
    expect(await page.weeks('offer')).toEqual(['This week'])
    await expect.poll(async () => (await tracking(app.workspace!, backlogFolder(12))).status).toBe('offer')
    expect(Date.parse(String((await tracking(app.workspace!, backlogFolder(12))).statusChangedAt))).toBeGreaterThan(Date.now() - 5 * 60_000)

    // Moved back, it is in Applied's This week too, not in the folded Last week it came from.
    await page.openMenu('Applied role 12')
    await app.window.getByRole('menuitem', { name: 'Applied', exact: true }).click()
    await expect(page.week('applied', 'This week').getByRole('article', { name: 'Applied role 12', exact: true })).toBeVisible()
    await expect(page.column('offer').getByLabel('0 cards', { exact: true })).toBeVisible()

    // Drag onto the rail.
    await page.openAllWeeks('applied')
    await page.drag('Applied role 20', 'offer')
    await page.expectIn('offer', 'Applied role 20')
    await expect.poll(async () => (await tracking(app.workspace!, backlogFolder(20))).status).toBe('offer')
  })

  test("a compact card at the bottom of a column shows its whole card inside the column, on hover and on focus", async ({ app }) => {
    // The window's minimum size: the least room a column has.
    await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
    const page = await openBacklog(app)
    await page.weekToggle('applied', 'This week').click()
    await page.openAllWeeks('applied')
    const last = page.card('Applied role 57')
    await last.scrollIntoViewIfNeeded()

    /** How far the card's full face (its foot included) sticks out of the column's scrolling list, in px. */
    const clipped = () =>
      last.evaluate((card) => {
        let box = card.parentElement
        while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement
        const f = card.firstElementChild!.getBoundingClientRect()
        const b = box!.getBoundingClientRect()
        return Math.max(0, b.top - f.top) + Math.max(0, f.bottom - b.bottom)
      })

    await last.hover()
    await expect(last.getByText('No report')).toBeVisible()
    await expect.poll(clipped).toBe(0)

    await app.window.mouse.move(2, 2)
    await expect(last.getByText('No report')).toBeHidden()
    // Keyboard focus: Tab from its week's header (the oldest week holds only this card).
    await page.column('applied').getByRole('group').last().getByRole('button').first().focus()
    await app.window.keyboard.press('Tab')
    // Not toBeFocused: the test window need not be the OS's active window.
    await expect.poll(() => app.window.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Applied role 57')
    await expect(last.getByText('No report')).toBeVisible()
    await expect.poll(clipped).toBe(0)
  })

  test('search and the source filter narrow every column, and the counts follow', async ({ app }) => {
    const page = await openBacklog(app)

    await page.search.fill('company 03')
    await expect(page.column('applied').getByLabel('1 cards', { exact: true })).toBeVisible()
    await page.expectIn('applied', 'Applied role 03')
    for (const id of ['ready', 'interviewing', 'rejected'] as const) await expect(page.column(id).getByLabel('0 cards', { exact: true })).toBeVisible()
    await expect(page.cards('todo')).toHaveCount(0)

    // Notes are searched too: the demo's Globex application was "Referred by a former colleague."
    await page.search.fill('FORMER colleague')
    await page.expectIn('applied', DEMO.globex)
    await expect(page.column('applied').getByLabel('1 cards', { exact: true })).toBeVisible()

    await page.search.fill('')
    await page.filterSources('Jobright')
    await page.expectIn('todo', 'Growth Engineer')
    await expect(page.column('todo').getByLabel('1 cards', { exact: true })).toBeVisible()
    await expect(page.column('applied').getByLabel('0 cards', { exact: true })).toBeVisible()

    await page.filterSources('Pasted')
    await page.expectIn('tailoring', 'Site Reliability Engineer')
    await page.expectIn('review', 'Machine Learning Engineer')
    await page.expectIn('archived', 'Solutions Architect')
    await expect(page.column('todo').getByLabel('1 cards', { exact: true })).toBeVisible()

    // Search and source together.
    await page.search.fill('hooli')
    await expect(page.column('todo').getByLabel('1 cards', { exact: true })).toBeVisible()
    await expect(page.column('tailoring').getByLabel('1 cards', { exact: true })).toBeVisible()
    await expect(page.column('review').getByLabel('0 cards', { exact: true })).toBeVisible()

    await page.page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(page.search).toHaveValue('')
    await expect(page.column('applied').getByLabel('58 cards', { exact: true })).toBeVisible()
  })
})
