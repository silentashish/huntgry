import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { Dashboard } from '../pages/dashboard'
import { Shell } from '../pages/shell'

/**
 * Dashboard flows on the `demo` workspace (see e2e/fixtures/workspaces/README.md
 * for its five applications). Every write lands in the sandbox copy and is
 * asserted on disk.
 */
test.use({ workspace: 'demo' })

const ALL = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Wayne']
const tracking = async (workspace: string, id: string) =>
  JSON.parse(await readFile(join(workspace, id, 'huntgry.json'), 'utf8')) as Record<string, unknown>

test.describe('dashboard rows', () => {
  test('rows show company, role, job title, status and build result for every application', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await new Shell(app.window).expectActive('dashboard')
    await dash.expectCompanies(ALL)

    // Company, role (from the folder), job title (from job-description.md) and source.
    await expect(dash.row('Acme')).toContainText('Software Engineer')
    await expect(dash.row('Acme')).toContainText('Senior Software Engineer')
    await expect(dash.row('Globex')).toContainText('Backend Engineer, Reporting')
    await expect(dash.row('Globex')).toContainText('manual')
    await expect(dash.row('Initech')).toContainText('hiring.cafe')

    // Status comes from huntgry.json; the applied date is shown under Created.
    await expect(dash.rowStatus('Acme')).toHaveValue('Generated')
    await expect(dash.rowStatus('Globex')).toHaveValue('Applied')
    await expect(dash.row('Globex')).toContainText('applied 2026-09-20')
    await expect(dash.rowStatus('Initech')).toHaveValue('Interviewing')
    await expect(dash.rowStatus('Wayne')).toHaveValue('Rejected')

    // Build result from build-report.json: ok, failed, missing.
    await expect(dash.row('Acme')).toContainText('ATS passed')
    await expect(dash.row('Globex')).toContainText('Build failed')
    await expect(dash.row('Umbrella')).toContainText('No report')

    // Summary cards count the statuses.
    for (const [label, count] of [['Total', '5'], ['Generated', '2'], ['Applied', '1'], ['Interviewing', '1'], ['Offer', '0'], ['Rejected', '1']] as const) {
      await expect(dash.statCard(label)).toHaveText(`${label}${count}`)
    }
  })

  test('the status cards, the status filter and the search narrow the table', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await dash.expectCompanies(ALL)

    await dash.statCard('Applied').click()
    await dash.expectCompanies(['Globex'])
    await dash.statCard('Generated').click()
    await dash.expectCompanies(['Acme', 'Umbrella'])
    await dash.statCard('Total').click()
    await dash.expectCompanies(ALL)

    // The status multi-select adds to the selection.
    await dash.statusFilter.click()
    await app.window.getByRole('option', { name: 'Interviewing' }).click()
    await app.window.getByRole('option', { name: 'Rejected' }).click()
    await app.window.keyboard.press('Escape')
    await dash.expectCompanies(['Initech', 'Wayne'])
    await dash.statCard('Total').click()

    // Sorting by company puts Acme first, whatever the file mtimes say.
    await dash.pickStatus(dash.sortSelect, 'Company')
    await expect(dash.rows.first()).toContainText('Acme')
    await expect(dash.rows.last()).toContainText('Wayne')
    await dash.pickStatus(dash.sortSelect, 'Newest first')

    // Search matches company, role, job title and notes, case-insensitively.
    await dash.searchInput.fill('globex')
    await dash.expectCompanies(['Globex'])
    await dash.searchInput.fill('Streaming')
    await dash.expectCompanies(['Umbrella'])
    await dash.searchInput.fill('take-home')
    await dash.expectCompanies(['Wayne'])
    await dash.searchInput.fill('no such application')
    await expect(dash.rows).toHaveCount(0)
    await expect(dash.nothingMatches).toBeVisible()
    await dash.clearFiltersLink.click()
    await expect(dash.searchInput).toHaveValue('')
    await dash.expectCompanies(ALL)
  })

  test('changing the status in a row writes huntgry.json; "Applied" stamps today as appliedAt', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await dash.expectCompanies(ALL)
    const id = 'software-engineer/acme/acme-4821'
    expect(await tracking(app.workspace!, id)).toEqual({ status: 'generated', notes: '' })

    // The app stamps the UTC date (toISOString) at write time; take it before and after the action so a
    // run that straddles UTC midnight accepts either day.
    const utcDate = () => new Date().toISOString().slice(0, 10)
    const before = utcDate()
    await dash.pickStatus(dash.rowStatus('Acme'), 'Applied')
    await expect(dash.row('Acme')).toContainText(/applied \d{4}-\d{2}-\d{2}/)
    const after = utcDate()
    await expect.poll(() => tracking(app.workspace!, id)).toMatchObject({ status: 'applied', notes: '' })
    const written = await tracking(app.workspace!, id)
    expect(Object.keys(written).sort()).toEqual(['appliedAt', 'notes', 'status'])
    expect(written.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect([before, after]).toContain(written.appliedAt)
    const today = written.appliedAt as string

    // The summary cards follow.
    await expect(dash.statCard('Applied')).toHaveText('Applied2')
    await expect(dash.statCard('Generated')).toHaveText('Generated1')

    // Back to generated: appliedAt stays (the date is history, the status is the user's call).
    await dash.pickStatus(dash.rowStatus('Acme'), 'Interviewing')
    await expect.poll(() => tracking(app.workspace!, id)).toMatchObject({ status: 'interviewing', appliedAt: today })
  })
})

test.describe('application drawer', () => {
  test('shows the job description, the files and the tracking fields; status and notes edits persist', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await dash.expectCompanies(ALL)
    const drawer = await dash.open('Umbrella')
    const id = 'data-engineer/umbrella/umb-12'

    await expect(drawer.getByText('Data Engineer, Streaming')).toBeVisible()
    await expect(drawer.getByText('No build report')).toBeVisible()
    // No resume.pdf and no cover.pdf: no Open buttons in the toolbar, no page previews (only the
    // "use Open resume instead" link of the empty preview panel carries that name).
    await expect(drawer.getByRole('button', { name: 'Open cover letter' })).toHaveCount(0)
    await expect(drawer.getByRole('tab', { name: 'Resume (0)' })).toHaveAttribute('aria-selected', 'true')
    await expect(drawer.getByRole('tab', { name: 'Cover letter (0)' })).toBeDisabled()
    const noPreviews = drawer.getByText('No page previews in this folder.')
    await expect(noPreviews).toBeVisible()
    await expect(drawer.getByRole('button', { name: 'Open resume', exact: true })).toHaveCount(1)
    await expect(noPreviews.getByRole('button', { name: 'Open resume', exact: true })).toBeVisible()
    await expect(drawer.getByLabel('Job posting URL')).toHaveValue('https://jobs.example.com/umbrella/12')

    await drawer.getByRole('tab', { name: 'Job description' }).click()
    await expect(drawer.getByText('Umbrella Analytics is building a streaming warehouse on Kafka and Spark.')).toBeVisible()

    // Status from the drawer.
    await dash.pickStatus(drawer.getByRole('combobox', { name: 'Status' }), 'Interviewing')
    await expect.poll(() => tracking(app.workspace!, id)).toMatchObject({ status: 'interviewing' })
    await expect(dash.rowStatus('Umbrella')).toHaveValue('Interviewing')

    // Notes are written when the field loses focus.
    await drawer.getByLabel('Notes').fill('Recruiter: Dana. Take-home due Friday.')
    await drawer.getByLabel('Notes').blur()
    await expect.poll(() => tracking(app.workspace!, id)).toEqual({
      status: 'interviewing',
      notes: 'Recruiter: Dana. Take-home due Friday.'
    })
    // No appliedAt was stamped: the status never was "applied".
    expect(await tracking(app.workspace!, id)).not.toHaveProperty('appliedAt')

    await dash.closeDrawer()
    // The notes are searchable right away.
    await dash.searchInput.fill('Dana')
    await dash.expectCompanies(['Umbrella'])
  })

  test('the huntgry-file:// page previews render for the resume and the cover letter', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await dash.expectCompanies(ALL)
    const drawer = await dash.open('Initech')

    await expect(drawer.getByRole('button', { name: 'Open resume', exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: 'Open cover letter' })).toBeVisible()
    await expect(drawer.getByText('ATS checks passed')).toBeVisible()
    await expect(drawer.getByLabel('Applied on')).toHaveValue('2026-09-22')
    await expect(drawer.getByLabel('Notes')).toHaveValue('Phone screen done; on-site scheduled.')

    const natural = (img: import('@playwright/test').Locator) =>
      img.evaluate((el) => {
        const i = el as HTMLImageElement
        return { src: i.src, complete: i.complete, width: i.naturalWidth, height: i.naturalHeight }
      })

    // The image is served by the app's own scheme, not from the filesystem directly, and decodes to its real size.
    const resume = drawer.getByRole('img', { name: 'resume-page-1.jpg' })
    await expect(resume).toBeVisible()
    await expect.poll(() => natural(resume)).toEqual({
      src: 'huntgry-file://app/platform-engineer/initech/init-9/resume-page-1.jpg',
      complete: true,
      width: 96,
      height: 124
    })

    await drawer.getByRole('tab', { name: 'Cover letter (1)' }).click()
    const cover = drawer.getByRole('img', { name: 'cover-page-1.jpg' })
    await expect(cover).toBeVisible()
    await expect.poll(() => natural(cover)).toMatchObject({ complete: true, width: 96, height: 124 })
  })
})

test.describe('workspace watch', () => {
  test('an application folder added on disk while the app runs appears without pressing Refresh', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await dash.expectCompanies(ALL)

    const folder = join(app.workspace!, 'sre', 'stark', 'st-1')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'job-description.md'),
      '# Site Reliability Engineer\n\nhttps://jobs.example.com/stark/1\n\nStark Industries needs an SRE for its Go services.\n'
    )
    await writeFile(join(folder, 'resume_data.json'), '{"contact":{"name":"Alex Rivera"}}\n')

    // fs.watch → debounce (600 ms) → applications:changed → the dashboard re-lists. No click involved.
    await dash.expectCompanies([...ALL, 'Stark'])
    await expect(dash.row('Stark')).toContainText('SRE')
    await expect(dash.row('Stark')).toContainText('Site Reliability Engineer')
    await expect(dash.rowStatus('Stark')).toHaveValue('Generated')
    await expect(dash.statCard('Total')).toHaveText('Total6')

    // A new job description also changes the insights: the SRE posting is counted.
    await expect(app.window.getByText(/compared with 7 job descriptions/)).toBeVisible()
  })
})

test.describe('apply readiness', () => {
  test('Apply is disabled with the reason when resume.pdf or the posting URL is missing', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await dash.expectCompanies(ALL)

    // No resume.pdf.
    const umbrella = dash.row('Umbrella').getByRole('button', { name: 'Apply', exact: true })
    await expect(umbrella).toBeDisabled()
    await umbrella.hover({ force: true })
    await expect(dash.tooltip('No resume.pdf yet: build the resume in Tailor first.')).toBeVisible()

    // resume.pdf but no URL in job-description.md nor huntgry.json.
    const wayne = dash.row('Wayne').getByRole('button', { name: 'Apply', exact: true })
    await expect(wayne).toBeDisabled()
    await wayne.hover({ force: true })
    await expect(dash.tooltip('No posting URL: add it in the application drawer first.')).toBeVisible()
    await expect(dash.row('Wayne').getByRole('button', { name: 'Open job posting' })).toBeDisabled()

    // Both present: enabled, with the hint.
    const acme = dash.row('Acme').getByRole('button', { name: 'Apply', exact: true })
    await expect(acme).toBeEnabled()
    await acme.hover()
    await expect(dash.tooltip(/^Apply: fill the application form in the in-app browser/)).toBeVisible()

    // The drawer says the same, and adding the URL there unblocks Apply (the Apply flow itself is #49).
    const drawer = await dash.open('Wayne')
    await expect(drawer.getByRole('button', { name: 'Apply in browser' })).toBeDisabled()
    await drawer.getByLabel('Job posting URL').fill('https://jobs.example.com/wayne/3')
    await drawer.getByLabel('Job posting URL').blur()
    await expect(drawer.getByRole('button', { name: 'Apply in browser' })).toBeEnabled()
    await expect.poll(() => tracking(app.workspace!, 'frontend-engineer/wayne/wy-3')).toMatchObject({
      jobUrl: 'https://jobs.example.com/wayne/3'
    })
    await dash.closeDrawer()
    await expect(wayne).toBeEnabled()
  })
})
