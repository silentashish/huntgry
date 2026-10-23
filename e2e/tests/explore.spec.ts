import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/servers/fixture'
import { ExplorePage } from '../pages/explore'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'

/**
 * Explore (#142) against the mock Jobright list on 127.0.0.1 (`/jobright/README.md`, dated relative to today,
 * from `scripts/mock-ats/jobright.mjs`); the app is pointed there by `HUNTGRY_EXPLORE_SOURCE_URL`, so GitHub
 * and jobright.ai are never reached.
 */
test.use({ workspace: 'mocks' })

const README = '/jobright/README.md'
const readmeFetches = (requests: string[]) => requests.filter((r) => r === README).length
const cacheFile = (workspace: string) => join(workspace, '.huntgry/explore/jobright.json')
const jobFile = (workspace: string, id: string) => join(workspace, '.huntgry/jobs', `jobright-${id}.json`)

async function openExplore(window: import('@playwright/test').Page): Promise<ExplorePage> {
  await new Shell(window).goTo('explore')
  const explore = new ExplorePage(window)
  await expect(explore.heading).toBeVisible()
  return explore
}

test.describe('Explore (#142)', () => {
  test('lists today first, filters a day, adds a job and opens it on the Jobs page', async ({ app, mock }) => {
    const explore = await openExplore(app.window)

    // Today's jobs are the default view; the malformed row (a link to another host) is dropped.
    await expect(explore.day('Today')).toHaveAttribute('aria-pressed', 'true')
    await expect(explore.day('Today')).toHaveAccessibleName(/^Today\s*3$/)
    await expect(explore.day('Yesterday')).toHaveAccessibleName(/^Yesterday\s*2$/)
    await expect(explore.days.getByRole('button')).toHaveCount(3)
    await expect
      .poll(() => explore.listedTitles())
      .toEqual(['Software Engineer, New Grad', 'Backend Engineer I', 'Embedded Software Engineer'])
    await expect(app.window.getByText('Too good to be true')).toHaveCount(0)
    // ↳ took the previous row's company.
    await expect(explore.row('Backend Engineer I')).toContainText('Northwind Labs · Remote, United States')
    await expect(app.window.getByText('Updated just now')).toBeVisible()

    // The list was fetched once and cached in the workspace.
    expect(readmeFetches(mock.requests)).toBe(1)
    const cache = JSON.parse(await readFile(cacheFile(app.workspace!), 'utf8'))
    expect(cache.jobs).toHaveLength(6)

    // Another day, then the text and work-model filters.
    await explore.pickDay('Yesterday')
    await expect.poll(() => explore.listedTitles()).toEqual(['Associate Data Engineer', 'Platform Engineer, Early Career'])
    await explore.workModel('On Site')
    await expect.poll(() => explore.listedTitles()).toEqual(['Platform Engineer, Early Career'])
    await explore.workModel('Any')
    await explore.filterInput.fill('associate')
    await expect.poll(() => explore.listedTitles()).toEqual(['Associate Data Engineer'])
    await explore.filterInput.fill('')
    await explore.pickDay('Today')

    // Add to Jobs: saved through the jobs store as a jobright job.
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
    expect(readmeFetches(mock.requests)).toBe(1)
    const files = (await readdir(join(app.workspace!, '.huntgry/jobs'))).filter((n) => n.startsWith('jobright-'))
    expect(files).toEqual(['jobright-e2e0000000000000000000a2.json'])
    const after = JSON.parse(await readFile(jobFile(app.workspace!, 'e2e0000000000000000000a2'), 'utf8'))
    expect(after.descriptionComplete).toBe(true)
  })

  test('Refresh re-fetches, and a failed refresh is shown inline over the cached list', async ({ app, mock }) => {
    const explore = await openExplore(app.window)
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)

    await explore.refreshButton.click()
    await expect.poll(() => readmeFetches(mock.requests)).toBe(2)

    mock.jobright.status = 503
    await explore.refreshButton.click()
    await expect(explore.error).toContainText('GitHub answered HTTP 503')
    // The cached list stays on screen.
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)
  })

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

  test('with no cache and the list unreachable, the page shows the error, not a blank page', async ({ app, mock }) => {
    mock.jobright.status = 500
    const explore = await openExplore(app.window)
    await expect(explore.error).toContainText('GitHub answered HTTP 500')
    await expect(app.window.getByRole('heading', { name: 'No jobs to explore yet' })).toBeVisible()
    mock.jobright.status = 200
    await explore.refreshButton.click()
    await expect.poll(() => explore.listedTitles()).toHaveLength(3)
  })
})
