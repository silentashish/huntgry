import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/servers/fixture'
import { ExplorePage } from '../pages/explore'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'

/**
 * Explore (#142, #169) against the mock Jobright on 127.0.0.1: the newgrad-jobs API
 * (`POST /jobright/swan/mini-sites/list`) and its README fallback (`/jobright/README.md`), both dated relative to
 * today, from `scripts/mock-ats/jobright.mjs`. The app is pointed there by `HUNTGRY_EXPLORE_API_URL` and
 * `HUNTGRY_EXPLORE_SOURCE_URL`, so jobright.ai and GitHub are never reached.
 */
test.use({ workspace: 'mocks' })

const README = '/jobright/README.md'
const API = '/jobright/swan/mini-sites/list'
const readmeFetches = (requests: string[]) => requests.filter((r) => r === README).length
const apiFetches = (requests: string[]) => requests.filter((r) => r.startsWith(`${API}?`)).length
const cacheFile = (workspace: string, category = 'newgrad.us.swe') => join(workspace, `.huntgry/explore/${category}.json`)
const jobFile = (workspace: string, id: string) => join(workspace, '.huntgry/jobs', `jobright-${id}.json`)

/** `HUNTGRY_DOC_SHOTS=1` saves the page at a few points for docs/changes/150-images (the PR's screenshots). */
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (process.env.HUNTGRY_DOC_SHOTS) await page.screenshot({ path: join(__dirname, '../../docs/changes/150-images', `${name}.png`) })
}

async function openExplore(window: import('@playwright/test').Page): Promise<ExplorePage> {
  await new Shell(window).goTo('explore')
  const explore = new ExplorePage(window)
  await expect(explore.heading).toBeVisible()
  return explore
}

test.describe('Explore (#142, #169)', () => {
  test('lists from the API, today first, filters, adds a job and opens it on the Jobs page', async ({ app, mock }) => {
    const explore = await openExplore(app.window)

    // The API list: today's jobs are the default view; its malformed entries (a bad id, no title) are dropped.
    await expect(explore.source).toHaveText('newgrad-jobs API · 12 jobs')
    await expect(explore.fallback).toHaveCount(0)
    await expect(explore.day('Today')).toHaveAttribute('aria-pressed', 'true')
    await expect(explore.day('Today')).toHaveAccessibleName(/^Today\s*3$/)
    await expect(explore.day('Yesterday')).toHaveAccessibleName(/^Yesterday\s*2$/)
    await expect
      .poll(() => explore.listedTitles())
      .toEqual(['Software Engineer, New Grad', 'Backend Engineer I', 'Embedded Software Engineer'])
    await expect(app.window.getByText('Too good to be true')).toHaveCount(0)
    await expect(app.window.getByText('No Title Inc')).toHaveCount(0)
    // The API's fields are on the row.
    await expect(explore.row('Software Engineer, New Grad')).toContainText('$120k–$145k/yr · Cloud Computing, Software · 1001-5000 people')
    await expect(explore.row('Software Engineer, New Grad')).toContainText('H1B: Yes')
    await expect(app.window.getByText('Updated just now')).toBeVisible()

    // Fetched once (one page: 12 rows is under the 500 asked for), never the README, and cached per category.
    expect(apiFetches(mock.requests)).toBe(1)
    expect(mock.requests).toContain(`${API}?position=0&count=500`)
    expect(readmeFetches(mock.requests)).toBe(0)
    const cache = JSON.parse(await readFile(cacheFile(app.workspace!), 'utf8'))
    expect(cache).toMatchObject({ category: 'newgrad:us:swe', source: 'api', total: 14 })
    expect(cache.jobs).toHaveLength(12)
    // Rows carry the qualifications (#150 scores from them).
    expect(cache.jobs[0].qualifications).toMatch(/^1\. A degree in computer science/)

    // Another day, then the text and work-model filters.
    await explore.pickDay('Yesterday')
    await expect.poll(() => explore.listedTitles()).toEqual(['Associate Data Engineer', 'Platform Engineer, Early Career'])
    await explore.workModel('On Site')
    await expect.poll(() => explore.listedTitles()).toEqual(['Platform Engineer, Early Career'])
    await explore.workModel('Any')
    await explore.filterInput.fill('associate')
    await expect.poll(() => explore.listedTitles()).toEqual(['Associate Data Engineer'])
    await explore.filterInput.fill('fintech')
    await expect.poll(() => explore.listedTitles()).toEqual(['Associate Data Engineer', 'Platform Engineer, Early Career'])
    await explore.filterInput.fill('')
    await explore.pickDay('Today')

    // H1B and minimum salary ($60/hr is $124,800 a year); filters never call the API.
    await explore.filterH1b('Sponsors H1B')
    await expect.poll(() => explore.listedTitles()).toEqual(['Software Engineer, New Grad'])
    await explore.filterH1b('H1B not ruled out')
    await expect.poll(() => explore.listedTitles()).toEqual(['Software Engineer, New Grad', 'Embedded Software Engineer'])
    await explore.minSalary.fill('130000')
    await expect.poll(() => explore.listedTitles()).toEqual(['Software Engineer, New Grad'])
    await explore.minSalary.fill('')
    await explore.filterH1b('Any H1B')
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)
    expect(apiFetches(mock.requests)).toBe(1)

    // Add to Jobs: saved through the jobs store as a jobright job, exactly as before (plus the API's pay).
    await explore.addButton('Backend Engineer I').click()
    await expect(explore.addedButton('Backend Engineer I')).toBeVisible()
    const saved = JSON.parse(await readFile(jobFile(app.workspace!, 'e2e0000000000000000000a2'), 'utf8'))
    expect(saved).toMatchObject({
      id: 'jobright:e2e0000000000000000000a2',
      source: 'jobright',
      title: 'Backend Engineer I',
      company: 'Northwind Labs',
      url: `${mock.origin}/jobs/info/e2e0000000000000000000a2`,
      boardUrl: `${mock.origin}/jobs/info/e2e0000000000000000000a2`,
      remote: true,
      salary: '$95000-$110000/yr',
      descriptionComplete: false
    })
    expect(saved.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00\.000Z$/)
    // Nothing was loaded to add it.
    expect(mock.requests.filter((r) => r.startsWith('/jobs/info/'))).toEqual([])

    // Added opens the job on the Jobs page.
    await explore.addedButton('Backend Engineer I').click()
    const jobs = new JobsPage(app.window)
    await expect(jobs.drawer).toBeVisible()
    await expect(jobs.drawer.getByText('Backend Engineer I', { exact: true }).first()).toBeVisible()
    await expect(jobs.drawer.getByText('Jobright', { exact: true })).toBeVisible()

    // Fetch full description follows the Jobright link and saves the posting.
    await jobs.drawerButton('Fetch full description').click()
    await expect(jobs.drawer.getByText(/is hiring a Backend Engineer I/)).toBeVisible({ timeout: 30_000 })
    await jobs.closeDrawer()
    await jobs.show('All')
    await expect(jobs.card('Backend Engineer I')).toBeVisible()

    // Reopening Explore is served from the cache; the row stays Added and adding is idempotent.
    await new Shell(app.window).goTo('explore')
    await expect(explore.addedButton('Backend Engineer I')).toBeVisible()
    expect(apiFetches(mock.requests)).toBe(1)
    const files = (await readdir(join(app.workspace!, '.huntgry/jobs'))).filter((n) => n.startsWith('jobright-'))
    expect(files).toEqual(['jobright-e2e0000000000000000000a2.json'])
    const after = JSON.parse(await readFile(jobFile(app.workspace!, 'e2e0000000000000000000a2'), 'utf8'))
    expect(after.descriptionComplete).toBe(true)
  })

  test('every row shows its match score from the qualifications; sort by match and Match ≥ N (#150)', async ({ app, mock }) => {
    const explore = await openExplore(app.window)
    // The mock's qualifications against the mocks profile (Go, Python, TypeScript, SQL, AWS, Terraform, Docker, PostgreSQL).
    await expect(explore.matchBadge('Software Engineer, New Grad')).toHaveAccessibleName('Match 25 of 100')
    await expect(explore.matchBadge('Backend Engineer I')).toHaveAccessibleName('Match 80 of 100')
    await expect(explore.matchBadge('Embedded Software Engineer')).toHaveAccessibleName('Match 100 of 100')
    // API rows are exact, never "≈".
    await expect(explore.list).not.toContainText('≈')

    // Hover shows what the score is made of; so does keyboard focus.
    await explore.matchBadge('Backend Engineer I').hover()
    await expect(explore.tooltip).toContainText('Match 80 of 100')
    await expect(explore.tooltip).toContainText('You have: Go, Python')
    await expect(explore.tooltip).toContainText('Missing: Kafka')
    await shot(app.window, 'explore-match-tooltip')
    await app.window.mouse.move(0, 0)
    await expect(explore.tooltip).toHaveCount(0)
    // From the keyboard: Tab back onto the badge (a focus the tooltip counts as keyboard focus).
    await explore.matchBadge('Software Engineer, New Grad').focus()
    await app.window.keyboard.press('Shift+Tab')
    await app.window.keyboard.press('Tab')
    await expect(explore.matchBadge('Software Engineer, New Grad')).toBeFocused()
    await expect(explore.tooltip).toContainText('Missing: Java, Kubernetes, React')
    await explore.matchBadge('Software Engineer, New Grad').blur()
    await expect(explore.tooltip).toHaveCount(0)

    // Best match first; Match ≥ N; both on top of the work-model filter and the day.
    await explore.sortBy('Best match')
    await expect
      .poll(() => explore.listedTitles())
      .toEqual(['Embedded Software Engineer', 'Backend Engineer I', 'Software Engineer, New Grad'])
    await explore.minMatch.fill('50')
    await expect.poll(() => explore.listedTitles()).toEqual(['Embedded Software Engineer', 'Backend Engineer I'])
    await shot(app.window, 'explore-best-match-filter')
    await explore.workModel('Remote')
    await expect.poll(() => explore.listedTitles()).toEqual(['Backend Engineer I'])
    await explore.workModel('Any')
    await explore.minMatch.fill('')
    await explore.sortBy('Newest first')
    await expect
      .poll(() => explore.listedTitles())
      .toEqual(['Software Engineer, New Grad', 'Backend Engineer I', 'Embedded Software Engineer'])
    // Other days' rows are scored too.
    await explore.pickDay('Yesterday')
    await expect(explore.matchBadge('Platform Engineer, Early Career')).toHaveAccessibleName('Match 100 of 100')

    // Scoring loaded nothing: one API fetch, no posting page.
    expect(apiFetches(mock.requests)).toBe(1)
    expect(mock.requests.filter((r) => r.startsWith('/jobs/info/'))).toEqual([])

    // An added job keeps the qualifications as its description, so Jobs and Automation score it the same way.
    await explore.pickDay('Today')
    await explore.addButton('Backend Engineer I').click()
    await expect(explore.addedButton('Backend Engineer I')).toBeVisible()
    const saved = JSON.parse(await readFile(jobFile(app.workspace!, 'e2e0000000000000000000a2'), 'utf8'))
    const cache = JSON.parse(await readFile(cacheFile(app.workspace!), 'utf8'))
    const row = cache.jobs.find((j: { id: string }) => j.id === 'e2e0000000000000000000a2')
    expect(saved.description).toBe(row.qualifications)
    expect(saved.descriptionComplete).toBe(false)

    // Reopening Explore scores again from the cache, without fetching anything.
    await new Shell(app.window).goTo('jobs')
    await new Shell(app.window).goTo('explore')
    await expect(explore.matchBadge('Backend Engineer I')).toHaveAccessibleName('Match 80 of 100')
    expect(apiFetches(mock.requests)).toBe(1)
    expect(mock.requests.filter((r) => r.startsWith('/jobs/info/'))).toEqual([])

    // The master profile gains Kafka: opened again, the same cached rows score against it.
    const profileFile = join(app.workspace!, 'master-profile.md')
    const profile = await readFile(profileFile, 'utf8')
    expect(profile).toContain('- Languages: Go, Python, TypeScript, SQL')
    await writeFile(profileFile, profile.replace('- Languages: Go, Python, TypeScript, SQL', '- Languages: Go, Python, TypeScript, SQL, Kafka'))
    await new Shell(app.window).goTo('jobs')
    await new Shell(app.window).goTo('explore')
    await expect(explore.matchBadge('Backend Engineer I')).toHaveAccessibleName('Match 100 of 100')
    await expect(explore.matchBadge('Software Engineer, New Grad')).toHaveAccessibleName('Match 25 of 100')
    await explore.matchBadge('Backend Engineer I').hover()
    await expect(explore.tooltip).toContainText('You have: Go, Python, Kafka')
    await expect(explore.tooltip).not.toContainText('Missing')
    await app.window.mouse.move(0, 0)
    await explore.sortBy('Best match')
    await explore.minMatch.fill('90')
    // Backend Engineer I (now 100) ties Contoso and keeps its listed place before it.
    await expect.poll(() => explore.listedTitles()).toEqual(['Backend Engineer I', 'Embedded Software Engineer'])
    expect(apiFetches(mock.requests)).toBe(1)
    expect(mock.requests.filter((r) => r.startsWith('/jobs/info/'))).toEqual([])
  })

  test('days past the newest seven fold under Earlier, and the fold is remembered', async ({ app }) => {
    const explore = await openExplore(app.window)
    await expect(explore.earlier).toHaveAttribute('aria-expanded', 'false')
    await expect(explore.earlier).toHaveAccessibleName('Earlier, 2 days, 2 jobs')
    // Seven days, then Earlier.
    await expect(explore.days.getByRole('button')).toHaveCount(8)
    await explore.earlier.click()
    await expect(explore.earlier).toHaveAttribute('aria-expanded', 'true')
    await expect(explore.days.getByRole('button')).toHaveCount(10)
    const oldest = explore.days.getByRole('button').last()
    await oldest.click()
    await expect.poll(() => explore.listedTitles()).toEqual(['Software Engineer I, Team 10'])

    await new Shell(app.window).goTo('jobs')
    await new Shell(app.window).goTo('explore')
    await expect(explore.earlier).toHaveAttribute('aria-expanded', 'true')
    await explore.earlier.click()
    await expect(explore.days.getByRole('button')).toHaveCount(8)
  })

  test('the category picker lists another category, caches it on its own, and is remembered', async ({ app, mock }) => {
    const explore = await openExplore(app.window)
    await expect(explore.category).toHaveValue('Software Engineering')
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)

    await explore.pickCategory('Data Analysis')
    await expect.poll(() => explore.listedTitles()).toEqual(['Junior Data Analyst'])
    await expect(explore.source).toHaveText('newgrad-jobs API · 1 job')
    expect(apiFetches(mock.requests)).toBe(2)
    expect(JSON.parse(await readFile(cacheFile(app.workspace!, 'newgrad.us.data_analysis'), 'utf8'))).toMatchObject({
      category: 'newgrad:us:data_analysis',
      source: 'api'
    })
    // A job of this category is added from its own list.
    await explore.addButton('Junior Data Analyst').click()
    await expect(explore.addedButton('Junior Data Analyst')).toBeVisible()

    // Remembered when the page is opened again; both categories are served from their caches.
    await new Shell(app.window).goTo('jobs')
    await new Shell(app.window).goTo('explore')
    await expect(explore.category).toHaveValue('Data Analysis')
    await expect.poll(() => explore.listedTitles()).toEqual(['Junior Data Analyst'])
    await explore.pickCategory('Software Engineering')
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)
    expect(apiFetches(mock.requests)).toBe(2)
  })

  test('Refresh re-fetches; with the API down it shows the README and says so', async ({ app, mock }) => {
    const explore = await openExplore(app.window)
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)

    await explore.refreshButton.click()
    await expect.poll(() => apiFetches(mock.requests)).toBe(2)

    // An HTTP 500: the README instead, the warning with the API's error, and no H1B / salary filters.
    mock.jobright.api.status = 500
    await explore.refreshButton.click()
    await expect(explore.fallback).toContainText('The newgrad-jobs API answered HTTP 500 for the Jobright jobs.')
    await expect(explore.source).toHaveText("Jobright's GitHub list (fallback) · 6 jobs")
    expect(readmeFetches(mock.requests)).toBe(1)
    await expect(explore.h1bFilter).toBeDisabled()
    await expect(explore.minSalary).toBeDisabled()
    await expect(explore.earlier).toHaveCount(0)
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)
    // The README rows are the same jobs: Add to Jobs works on them too.
    await explore.addButton('Software Engineer, New Grad').click()
    await expect(explore.addedButton('Software Engineer, New Grad')).toBeVisible()

    // Both down: the error is shown inline over the cached list.
    mock.jobright.status = 503
    await explore.refreshButton.click()
    await expect(explore.error).toContainText('GitHub answered HTTP 503')
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)

    // The API back: Refresh lists from it again.
    mock.jobright.api.status = 200
    await explore.refreshButton.click()
    await expect(explore.source).toHaveText('newgrad-jobs API · 12 jobs')
    await expect(explore.fallback).toHaveCount(0)
  })

  for (const [mode, reason] of [
    ['refuse', 'The newgrad-jobs API refused the request (error 50000).'],
    ['malformed', 'The newgrad-jobs API sent no job Huntgry could read.']
  ] as const) {
    test(`falls back to the README when the API answers ${mode === 'refuse' ? 'success: false' : 'only malformed rows'}`, async ({ app, mock }) => {
      mock.jobright.api.mode = mode
      const explore = await openExplore(app.window)
      await expect(explore.fallback).toContainText(reason)
      await expect(explore.source).toHaveText("Jobright's GitHub list (fallback) · 6 jobs")
      await expect
        .poll(() => explore.listedTitles())
        .toEqual(['Software Engineer, New Grad', 'Backend Engineer I', 'Embedded Software Engineer'])
      expect(JSON.parse(await readFile(cacheFile(app.workspace!), 'utf8'))).toMatchObject({ source: 'readme', fallbackReason: reason })
      // README rows have no qualifications: a title-only "≈" estimate (#150), which says so on hover.
      const badge = explore.matchBadge('Backend Engineer I')
      await expect(badge).toHaveAccessibleName(/^Match about \d+ of 100, a title-only estimate$/)
      await expect(badge).toHaveText(/^≈\d+/)
      await badge.hover()
      await expect(explore.tooltip).toContainText('a title-only estimate')
      await expect(explore.tooltip).toContainText('Title: Backend Engineer')
      if (mode === 'refuse') await shot(app.window, 'explore-readme-estimate')
      // The estimate sorts and filters like a score.
      await explore.minMatch.fill('100')
      await expect.poll(() => explore.listedTitles()).toEqual([])
      await explore.minMatch.fill('1')
      await expect.poll(() => explore.listedTitles()).toHaveLength(3)
    })
  }

  test('a Jobright page behind a human check says so, like Indeed', async ({ app, mock }) => {
    expect(mock.jobright.status).toBe(200)
    const explore = await openExplore(app.window)
    await explore.pickDay('Yesterday')
    await explore.addButton('Associate Data Engineer').click()
    await explore.addedButton('Associate Data Engineer').click()
    const jobs = new JobsPage(app.window)
    await expect(jobs.drawer).toBeVisible()
    await jobs.drawerButton('Fetch full description').click()
    await expect(jobs.drawer.getByText(/Jobright shows full job descriptions only after a human check/)).toBeVisible({
      timeout: 40_000
    })
  })

  test('Explore sits between Jobs and Browser and opens from the ⌘K palette', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.expectActive('dashboard')
    const labels = await shell.navbar.getByRole('button').evaluateAll((bs) => bs.map((b) => (b.textContent ?? '').trim()))
    const at = (name: string) => labels.findIndex((l) => l.startsWith(name))
    expect(at('Explore')).toBeGreaterThan(0)
    expect(at('Explore')).toBe(at('Jobs') + 1)
    expect(at('Browser')).toBe(at('Explore') + 1)
    await shell.openPalette()
    await shell.paletteInput.fill('explore')
    await expect(shell.paletteOption('Explore')).toHaveAttribute('aria-selected', 'true')
    await app.window.keyboard.press('Enter')
    await shell.expectActive('explore')
  })

  test('with no cache and both sources unreachable, the page shows the error, not a blank page', async ({ app, mock }) => {
    mock.jobright.api.status = 500
    mock.jobright.status = 500
    const explore = await openExplore(app.window)
    await expect(explore.error).toContainText('The newgrad-jobs API answered HTTP 500')
    await expect(explore.error).toContainText('GitHub answered HTTP 500')
    await expect(app.window.getByRole('heading', { name: 'No jobs to explore yet' })).toBeVisible()
    mock.jobright.api.status = 200
    await explore.refreshButton.click()
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)
    await expect(explore.source).toHaveText('newgrad-jobs API · 12 jobs')
  })
})
