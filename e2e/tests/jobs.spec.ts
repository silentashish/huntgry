import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnedChildren } from '../fixtures/app'
import { expect, test } from '../fixtures/servers/fixture'
import { BrowserPage } from '../pages/browser'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'

/**
 * The Jobs page against the mock job boards, posting pages and bot wall on
 * 127.0.0.1 (fixtures/servers). The app reaches them through the
 * `HUNTGRY_JOB_BOARD_BASE_URL_*` overrides and the loopback allowance; the
 * hidden loader's guard stays on for everything else.
 */
test.use({ workspace: 'mocks' })

const jobsDir = (workspace: string) => join(workspace, '.huntgry/jobs')
const jobFiles = async (workspace: string, prefix: string) => (await readdir(jobsDir(workspace))).filter((n) => n.startsWith(prefix))
const readJobs = async (workspace: string, prefix: string) =>
  Promise.all((await jobFiles(workspace, prefix)).map(async (n) => JSON.parse(await readFile(join(jobsDir(workspace), n), 'utf8'))))

/**
 * Opens Jobs. It opens on the jobs relevant to the master profile (#73), rendered from the saved jobs; the `mocks`
 * workspace turns auto-refresh off (`.huntgry/jobs-prefs.json`), so nothing loads a board unless a test asks.
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

/** The searchState objects the mock hiring.cafe was asked for. */
const searchStates = (requests: string[]) =>
  requests
    .filter((r) => r.startsWith('/?searchState='))
    .map((r) => JSON.parse(decodeURIComponent(r.slice('/?searchState='.length))))

test.describe('job search', () => {
  test('Search shows results from both boards and saves them under .huntgry/jobs', async ({ app, mock }) => {
    const jobs = await openJobs(app)
    await expect(jobs.board('hiring.cafe')).toBeChecked()
    await expect(jobs.board('Indeed')).toBeChecked()
    await jobs.search('engineer')

    await expect(jobs.report('hiring.cafe: 2 jobs')).toBeVisible()
    await expect(jobs.report('Indeed: 2 jobs')).toBeVisible()
    for (const title of ['Platform Engineer', 'Backend Engineer', 'Site Reliability Engineer', 'Data Engineer']) {
      await expect(jobs.jobTitle(title)).toBeVisible()
    }
    await expect(app.window.getByText('Vandelay Industries · Portland, Oregon, United States · $130,000 – $155,000 / year')).toBeVisible()
    await expect(app.window.getByRole('radio', { name: 'Last search (4)' })).toBeChecked()

    // Both board pages were read from the mock server, each once.
    expect(mock.requests.filter((r) => r.startsWith('/?searchState='))).toHaveLength(1)
    expect(mock.requests.filter((r) => r.startsWith('/jobs?q=engineer'))).toHaveLength(1)
    // One file per job, per board.
    expect(await jobFiles(app.workspace!, 'hiring.cafe-')).toHaveLength(2)
    expect(await jobFiles(app.workspace!, 'indeed-')).toHaveLength(2)
    const [indeed] = await readJobs(app.workspace!, 'indeed-')
    expect(indeed.url).toMatch(new RegExp(`^${mock.altOrigin}/viewjob\\?jk=`))
    expect(indeed.descriptionComplete).toBe(false)
    // The search is remembered.
    const searches = JSON.parse(await readFile(join(app.workspace!, '.huntgry/searches.json'), 'utf8'))
    expect(searches[0].query).toMatchObject({ keywords: 'engineer', sources: ['hiring.cafe', 'indeed'] })
  })

  test('the drawer shows the description, the source and the "summary only" notes; a hiring.cafe job can fetch its full posting', async ({
    app
  }) => {
    const jobs = await openJobs(app)
    await jobs.search('engineer')
    await expect(jobs.report('Indeed: 2 jobs')).toBeVisible()

    // Indeed: the card's snippet, and only that (its job pages sit behind a human check).
    await jobs.openJob('Site Reliability Engineer')
    await expect(jobs.drawer.getByText('Indeed', { exact: true })).toBeVisible()
    await expect(jobs.drawer).toContainText('Keep the fleet tracking platform up across three regions.')
    await expect(jobs.drawer).toContainText('Indeed search results include only a snippet')
    await expect(jobs.drawerButton('Fetch full description')).toHaveCount(0)
    await expect(jobs.drawer).toContainText('Umbrella Logistics · Atlanta, GA · $140,000 - $165,000 a year')
    await jobs.closeDrawer()

    // hiring.cafe: the board's summary, with the offer to fetch the employer's page.
    await jobs.openJob('Backend Engineer')
    await expect(jobs.drawer.getByText('hiring.cafe', { exact: true })).toBeVisible()
    await expect(jobs.drawer).toContainText('This is the job board’s summary, not the full posting.')
    await expect(jobs.drawer).toContainText('Requirements: Three years of Python services on AWS')
    await jobs.drawerButton('Fetch full description').click()
    await expect(jobs.drawer).toContainText('Vandelay Industries imports and exports fine latex goods')
    await expect(jobs.drawer).not.toContainText('This is the job board’s summary')
    const [saved] = (await readJobs(app.workspace!, 'hiring.cafe-')).filter((j) => j.title === 'Backend Engineer')
    expect(saved.descriptionComplete).toBe(true)
    expect(saved.description).toContain('forty warehouses')
  })

  test('results persist across a relaunch', async ({ app }) => {
    const jobs = await openJobs(app)
    await jobs.search('engineer')
    await expect(jobs.report('hiring.cafe: 2 jobs')).toBeVisible()

    await app.relaunch()
    const again = await openJobs(app)
    for (const title of ['Platform Engineer', 'Backend Engineer', 'Site Reliability Engineer', 'Data Engineer', 'Staff Backend Engineer']) {
      await expect(again.jobTitle(title)).toBeVisible()
    }
    await expect(app.window.getByText('6 of 6 saved jobs')).toBeVisible()
    // The last search is kept as well (#73), not only the jobs.
    await expect(again.segment('Last search')).toHaveAccessibleName('Last search (4)')
    // The recent search is offered again.
    await expect(app.window.getByRole('button', { name: 'engineer', exact: true })).toBeVisible()
  })
})

test.describe('relevant jobs, Refresh and filters (#73)', () => {
  test('Jobs opens on the relevant saved jobs, ranked against the profile, without loading a board', async ({ app, mock }) => {
    const jobs = await openJobs(app, 'Relevant')
    // Both seeded jobs fit "Backend Engineer" with Go: the closer title first.
    await expect(jobs.segment('Relevant')).toHaveAccessibleName('Relevant (2)')
    await expect.poll(() => jobs.listedTitles()).toEqual(['Staff Backend Engineer', 'Infrastructure Engineer'])
    await expect(app.window.getByText(/^Title: Backend Engineer · Skills: Go/)).toBeVisible()
    await expect(jobs.lastRefreshed).toHaveText('Relevant jobs updated never')
    expect(mock.requests).toEqual([])
  })

  test('Refresh with no keywords searches the boards for the profile headline near its location', async ({ app, mock }) => {
    const jobs = await openJobs(app, 'Relevant')
    await expect(jobs.keywords).toHaveValue('')
    await jobs.refreshButton.click()

    await expect(jobs.report('hiring.cafe: 2 jobs')).toBeVisible()
    await expect(jobs.report('Indeed: 2 jobs')).toBeVisible()
    await expect(jobs.lastRefreshed).toHaveText('Relevant jobs updated just now')
    await expect(jobs.segment('Relevant')).toBeChecked()
    // The new Portland backend job fits best and leads the list.
    await expect.poll(async () => (await jobs.listedTitles())[0]).toBe('Backend Engineer')

    // The profile's headline and location (Portland, OR) made the query; only the verified searchState key was sent.
    expect(searchStates(mock.requests)).toEqual([{ searchQuery: 'Backend Engineer' }])
    const indeed = mock.requests.filter((r) => r.startsWith('/jobs?'))
    expect(indeed).toHaveLength(1)
    expect(indeed[0]).toMatch(/[?&]q=Backend\+Engineer(&|$)/)
    expect(indeed[0]).toMatch(/[?&]l=Portland/)
    const prefs = JSON.parse(await readFile(join(app.workspace!, '.huntgry/jobs-prefs.json'), 'utf8'))
    expect(prefs.lastRefreshAt).toEqual(expect.any(String))
    expect(prefs.lastSearch).toMatchObject({ relevant: true, query: { keywords: 'Backend Engineer', location: 'Portland, OR' } })
  })

  test('"Only sponsors" hides the jobs that do not say they sponsor; filters and the last search survive leaving the page', async ({
    app
  }) => {
    const shell = new Shell(app.window)
    const jobs = await openJobs(app)
    await jobs.search('engineer')
    await expect(jobs.report('hiring.cafe: 2 jobs')).toBeVisible()
    await expect.poll(() => jobs.listedTitles()).toHaveLength(4)

    await jobs.filterSponsorship('Only sponsors')
    await expect.poll(() => jobs.listedTitles()).toEqual(['Platform Engineer'])
    await expect(app.window.getByText('Sponsors visa', { exact: true })).toBeVisible()

    await shell.goTo('dashboard')
    await shell.goTo('jobs')
    await expect(jobs.sponsorshipFilter).toHaveValue('Only sponsors')
    await jobs.show('Last search')
    await expect(jobs.segment('Last search')).toHaveAccessibleName('Last search (4)')
    await expect.poll(() => jobs.listedTitles()).toEqual(['Platform Engineer'])

    // Unknown counts as passing "Hide no sponsorship": every result is back.
    await jobs.filterSponsorship('Hide "no sponsorship"')
    await expect.poll(() => jobs.listedTitles()).toHaveLength(4)
    const prefs = JSON.parse(await readFile(join(app.workspace!, '.huntgry/jobs-prefs.json'), 'utf8'))
    expect(prefs.filters.sponsorship).toBe('hide-no')
  })

  test('with auto-refresh on, opening Jobs refreshes once in the background, then not again within 12 hours', async ({
    app,
    mock
  }) => {
    const shell = new Shell(app.window)
    const jobs = await openJobs(app)
    await expect(jobs.autoRefresh).not.toBeChecked()
    await jobs.toggleAutoRefresh(true)
    // Turning it on loads nothing by itself.
    expect(mock.requests).toEqual([])

    await shell.goTo('dashboard')
    await shell.goTo('jobs')
    // The saved relevant jobs are listed at once; the boards answer in the background.
    await expect(jobs.segment('Relevant')).toBeChecked()
    await expect(jobs.jobTitle('Staff Backend Engineer')).toBeVisible()
    await expect(jobs.report('hiring.cafe: 2 jobs')).toBeVisible()
    await expect(jobs.lastRefreshed).toHaveText('Relevant jobs updated just now')
    await expect(jobs.jobTitle('Backend Engineer')).toBeVisible()
    expect(searchStates(mock.requests)).toHaveLength(1)

    await shell.goTo('dashboard')
    await shell.goTo('jobs')
    await expect(jobs.autoRefresh).toBeChecked()
    await expect(jobs.jobTitle('Backend Engineer')).toBeVisible()
    await expect(app.window.getByText(/^Refreshing relevant jobs/)).toHaveCount(0)
    expect(searchStates(mock.requests)).toHaveLength(1)
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
    await expect(jobs.refreshButton).toBeDisabled()
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
