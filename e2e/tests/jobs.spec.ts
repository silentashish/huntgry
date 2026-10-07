import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnedChildren } from '../fixtures/app'
import { expect, test } from '../fixtures/servers/fixture'
import { BrowserPage } from '../pages/browser'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'

/**
 * The Jobs page against the mock posting pages and bot wall on 127.0.0.1
 * (fixtures/servers). The app reaches them through the loopback allowance;
 * the hidden loader's guard stays on for everything else. Huntgry does not
 * search job boards (#78): jobs are added by URL or pasted.
 */
test.use({ workspace: 'mocks' })

const jobsDir = (workspace: string) => join(workspace, '.huntgry/jobs')
const jobFiles = async (workspace: string, prefix: string) => (await readdir(jobsDir(workspace))).filter((n) => n.startsWith(prefix))
const readJobs = async (workspace: string, prefix: string) =>
  Promise.all((await jobFiles(workspace, prefix)).map(async (n) => JSON.parse(await readFile(join(jobsDir(workspace), n), 'utf8'))))

/**
 * Opens Jobs. It opens on the jobs relevant to the master profile (#73), rendered from the saved jobs.
 * Most tests then look at every saved job: `show` picks the segment.
 */
async function openJobs(
  app: { window: import('@playwright/test').Page },
  show: 'All' | 'Relevant' = 'All'
): Promise<JobsPage> {
  await new Shell(app.window).goTo('jobs')
  const jobs = new JobsPage(app.window)
  await expect(jobs.segment('Relevant')).toBeChecked()
  // The seeded jobs are listed before anything else happens.
  await expect(jobs.jobTitle('Infrastructure Engineer')).toBeVisible()
  if (show === 'All') await jobs.show('All')
  return jobs
}

/** The Jobs preferences as saved on disk; `{}` until the first change writes them. */
const savedPrefs = async (workspace: string) =>
  JSON.parse(await readFile(join(workspace, '.huntgry/jobs-prefs.json'), 'utf8').catch(() => '{}'))

test.describe('relevant jobs and filters (#73)', () => {
  test('Jobs opens on the relevant saved jobs, ranked against the profile, without loading a page', async ({ app, mock }) => {
    const jobs = await openJobs(app, 'Relevant')
    // Both seeded jobs fit "Backend Engineer" with Go: the closer title first.
    await expect(jobs.segment('Relevant')).toHaveAccessibleName('Relevant (2)')
    await expect.poll(() => jobs.listedTitles()).toEqual(['Staff Backend Engineer', 'Infrastructure Engineer'])
    await expect(app.window.getByText(/^Title: Backend Engineer · Skills: .*\bGo\b.* · Remote$/)).toBeVisible()
    // No board search or refresh is offered (#78).
    await expect(app.window.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
    await expect(app.window.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0)
    expect(mock.requests).toEqual([])
  })

  test('filters survive leaving the page', async ({ app }) => {
    const shell = new Shell(app.window)
    const jobs = await openJobs(app)
    await expect.poll(() => jobs.listedTitles()).toHaveLength(2)

    // Neither seeded job says it sponsors visas.
    await jobs.filterSponsorship('Only sponsors')
    await expect.poll(() => jobs.listedTitles()).toEqual([])
    // The page shows a change before main has saved it; leave only once it is on disk.
    await expect.poll(async () => (await savedPrefs(app.workspace!)).filters?.sponsorship).toBe('only-yes')

    await shell.goTo('dashboard')
    await shell.goTo('jobs')
    await expect(jobs.sponsorshipFilter).toHaveValue('Only sponsors')

    // Unknown counts as passing "Hide no sponsorship": every job is back.
    await jobs.filterSponsorship('Hide "no sponsorship"')
    await jobs.show('All')
    await expect.poll(() => jobs.listedTitles()).toHaveLength(2)
    await expect.poll(async () => (await savedPrefs(app.workspace!)).filters?.sponsorship).toBe('hide-no')
  })

  test('without a headline or a role, Jobs opens on All and says how to get relevant jobs', async ({ app, mock }) => {
    const path = join(app.workspace!, 'master-profile.md')
    const profile = await readFile(path, 'utf8')
    await writeFile(path, profile.replace(/^- Headline: .*$/m, '- Headline:').replace(/^- Role: .*$/gm, '- Role:'))

    await new Shell(app.window).goTo('jobs')
    const jobs = new JobsPage(app.window)
    await expect(jobs.relevantHint).toBeVisible()
    await expect(jobs.segment('All')).toBeChecked()
    await expect(jobs.segment('Relevant')).toHaveCount(0)
    await expect(jobs.jobTitle('Infrastructure Engineer')).toBeVisible()
    expect(mock.requests).toEqual([])
  })
})

test.describe('adding jobs', () => {
  test('add by URL saves the posting (JSON-LD and plain-text pages) and opens it', async ({ app, mock }) => {
    const jobs = await openJobs(app)
    await expect(jobs.addButton).toBeDisabled()
    await jobs.addByUrl(`${mock.origin}/postings/lever-style`)
    await expect(jobs.drawer).toBeVisible()
    await expect(jobs.drawer.getByText('Software Engineer', { exact: true }).first()).toBeVisible()
    await expect(jobs.drawer).toContainText('Acme · Denver, CO, US')
    await expect(jobs.drawer).toContainText('Acme makes anvils, rockets and the software that ships them.')
    await expect(jobs.drawer.getByText('Added by URL', { exact: true })).toBeVisible()
    await jobs.closeDrawer()

    // No JSON-LD: the page text is the posting and the title comes from the page title.
    await jobs.addByUrl(`${mock.origin}/postings/ashby-style`)
    await expect(jobs.drawer.getByText('Data Platform Engineer', { exact: true }).first()).toBeVisible()
    await expect(jobs.drawer).toContainText("Hooli's data platform team runs the pipelines")
    await jobs.closeDrawer()

    const added = await readJobs(app.workspace!, 'url-')
    const lever = added.find((j) => j.url === `${mock.origin}/postings/lever-style`)
    expect(lever).toMatchObject({ source: 'url', title: 'Software Engineer', company: 'Acme', descriptionComplete: true })
    const ashby = added.find((j) => j.url === `${mock.origin}/postings/ashby-style`)
    expect(ashby).toMatchObject({ source: 'url', title: 'Data Platform Engineer', descriptionComplete: true })
    await expect(app.window.getByText('4 of 4 saved jobs')).toBeVisible()
  })

  test('"Paste a job" saves the pasted description', async ({ app }) => {
    const jobs = await openJobs(app)
    await jobs.pasteButton.click()
    await expect(jobs.pasteModal).toBeVisible()
    await expect(jobs.pasteModal.getByRole('button', { name: 'Save job' })).toBeDisabled()
    await jobs.pasteModal.getByLabel('Title').fill('Robotics Software Engineer')
    await jobs.pasteModal.getByLabel('Company').fill('Wayne Enterprises')
    await jobs.pasteModal
      .getByLabel('Job description')
      .fill('Wayne Enterprises is hiring a Robotics Software Engineer for its Gotham lab. Remote within the US.\n\nRequirements: C++, ROS, five years.')
    await jobs.pasteModal.getByRole('button', { name: 'Save job' }).click()

    await expect(jobs.pasteModal).toBeHidden()
    await expect(jobs.drawer.getByText('Robotics Software Engineer', { exact: true }).first()).toBeVisible()
    await expect(jobs.drawer).toContainText('Wayne Enterprises')
    await expect(jobs.drawer.getByText('Pasted', { exact: true })).toBeVisible()
    const pasted = (await readJobs(app.workspace!, 'pasted-')).find((j) => j.company === 'Wayne Enterprises')
    expect(pasted).toMatchObject({ source: 'pasted', title: 'Robotics Software Engineer', remote: true, descriptionComplete: true })
  })

  test('a bot wall gives the blocked message', async ({ app, mock }) => {
    test.slow() // the loader gives a challenge page half its timeout to clear itself before reporting it
    const jobs = await openJobs(app)
    await jobs.addByUrl(`${mock.origin}/bot-wall`)
    await expect(jobs.error.filter({ hasText: 'asked for a human check' })).toContainText(
      `127.0.0.1:${mock.port} asked for a human check (Just a moment...). Paste the job description instead.`,
      { timeout: 40_000 }
    )
    expect(await jobFiles(app.workspace!, 'url-')).toHaveLength(1) // only the seeded job
  })

  test('the loader refuses private-network addresses even with the loopback allowance, and public ones under the harness', async ({
    app,
    mock
  }) => {
    const jobs = await openJobs(app)
    for (const [url, host] of [
      ['http://10.0.0.1/careers/1', '10.0.0.1'],
      ['http://192.168.1.10:8080/jobs/1', '192.168.1.10:8080'],
      ['http://169.254.169.254/latest/meta-data', '169.254.169.254']
    ]) {
      await jobs.addByUrl(url)
      await expect(jobs.error.filter({ hasText: 'Refusing to load' })).toContainText(
        `Refusing to load ${host}: it is a local or private-network address.`
      )
    }
    // A resolvable public posting URL is refused by the loopback-only egress restriction, before any lookup.
    await jobs.addByUrl('https://jobs.example.com/acme/1')
    await expect(jobs.error.filter({ hasText: 'Refusing to load' })).toContainText(
      'Refusing to load jobs.example.com: this test build may only reach loopback addresses.'
    )
    // Nothing was loaded, so nothing was saved; the mock server saw no request either.
    expect(await jobFiles(app.workspace!, 'url-')).toHaveLength(1)
    expect(mock.requests).toEqual([])
  })
})

test.describe('tailoring', () => {
  test('"Tailor resume" fetches the full posting from the employer page and prefills Tailor', async ({ app, mock }) => {
    const jobs = await openJobs(app)
    await jobs.openJob('Infrastructure Engineer')
    await expect(jobs.drawer).toContainText('This is the job board’s summary, not the full posting.')
    await jobs.drawerButton('Tailor resume').click()

    const shell = new Shell(app.window)
    await shell.expectActive('tailor')
    await expect(app.window.getByLabel('Company')).toHaveValue('Tyrell Robotics')
    await expect(app.window.getByLabel('Role')).toHaveValue('Infrastructure Engineer')
    await expect(app.window.getByLabel('Job id')).toHaveValue('mock-employer-103')
    await expect(app.window.getByLabel('Job posting URL')).toHaveValue(`${mock.origin}/postings/employer/103`)
    const description = app.window.getByLabel('Job description')
    await expect(description).toHaveValue(/^# Infrastructure Engineer\n/)
    await expect(description).toHaveValue(/Tyrell Robotics builds inspection robots for wind farms/)
    await expect(description).toHaveValue(/keep deployments boring/)
    // The full posting was read from the mock employer page and saved.
    expect(mock.requests).toContain('/postings/employer/103')
    const [saved] = await readJobs(app.workspace!, 'url-')
    expect(saved.descriptionComplete).toBe(true)
    expect(saved.tailoredAt).toEqual(expect.any(String))
  })

  test('ticking two jobs and "Tailor all" opens the queue view with both', async ({ app }) => {
    // The confirm button needs an agent that is ready: a fake `claude` in the sandbox bin and the skill under the sandbox HOME.
    const fake = join(app.sandbox.bin, 'claude')
    await writeFile(
      fake,
      '#!/bin/sh\ncase "$1" in\n  --version) echo "9.9.9 (Claude Code)" ;;\n  auth) echo "{\\"loggedIn\\":true}" ;;\nesac\n'
    )
    await chmod(fake, 0o755)
    const skill = join(app.home, '.claude/skills/resume-tailor')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: resume-tailor\n---\n')

    const jobs = await openJobs(app)
    await jobs.select('Infrastructure Engineer').check()
    await jobs.select('Staff Backend Engineer').check()
    await expect(jobs.selectionBar).toContainText('2 selected')
    await jobs.tailorAllButton.click()
    const modal = app.window.getByRole('dialog', { name: 'Tailor 2 jobs' })
    await expect(modal).toBeVisible()
    await expect(modal).toContainText("1 of 2 have only the board's summary")
    await modal.getByRole('button', { name: 'Tailor 2 jobs' }).click()

    await new Shell(app.window).expectActive('tailor')
    await expect(app.window.getByRole('heading', { name: 'Tailoring queue' })).toBeVisible()
    // Each queued job is listed (the queue panel and the run list both name it).
    await expect(app.window.getByText('Infrastructure Engineer · Tyrell Robotics').first()).toBeVisible()
    await expect(app.window.getByText('Staff Backend Engineer · Initech').first()).toBeVisible()

    // Queue execution is #48's; here the runs only have to be over before teardown. The fake `claude` exits at once,
    // so both items leave the queued/running states; the environment check's preflight child (`python3`) is waited
    // for by `closeApp` as well, so nothing the app spawned can outlive the sandbox.
    await expect
      .poll(async () => {
        const state = await app.window.evaluate(() =>
          (window as unknown as { huntgry: { queue: { state(): Promise<{ items: Array<{ status: string }> }> } } }).huntgry.queue.state()
        )
        return state.items.map((i) => i.status)
      }, { timeout: 30_000 })
      .toEqual(expect.arrayContaining([expect.stringMatching(/^(done|failed|cancelled)$/), expect.stringMatching(/^(done|failed|cancelled)$/)]))
    await expect.poll(() => spawnedChildren(app.electronApp.process().pid!), { timeout: 30_000 }).toEqual([])
  })
})

test('"Open posting" from the drawer lands on the Browser page with the posting URL', async ({ app, mock }) => {
  const jobs = await openJobs(app)
  await jobs.openJob('Staff Backend Engineer')
  await jobs.drawerButton('Open posting').click()
  await new Shell(app.window).expectActive('browser')
  await expect(new BrowserPage(app.window).address).toHaveValue(`${mock.origin}/postings/lever-style`)
})
