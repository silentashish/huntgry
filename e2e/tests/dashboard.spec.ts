import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PipelineSummary } from '../../src/shared/pipeline-types'
import { expect, test, type Preparer } from '../fixtures/app'
import { BoardPage } from '../pages/board'
import { Dashboard } from '../pages/dashboard'
import { InsightsCard } from '../pages/insights-card'
import { Shell } from '../pages/shell'

/**
 * Dashboard flows on the `demo` workspace (see e2e/fixtures/workspaces/README.md
 * for its five applications). The applications themselves are browsed on the
 * Board since #161 (board.spec.ts): here, the summary and its links to the Board.
 */
test.use({ workspace: 'demo' })

test.describe('dashboard summary', () => {
  test('the stat tiles count the statuses; no applications table is left (#161)', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await new Shell(app.window).expectActive('dashboard')

    for (const [label, count] of [['Total', '5'], ['Generated', '2'], ['Applied', '1'], ['Interviewing', '1'], ['Offer', '0'], ['Rejected', '1']] as const) {
      await expect(dash.statValue(label)).toHaveText(count)
    }
    // Tiles are links to the Board now, not toggles of a table filter.
    await expect(dash.statCard('Total')).not.toHaveAttribute('aria-pressed')
    await expect(dash.statCard('Total')).toContainText('5 new this week')

    // The table, its search, status filter and sort are gone; the side cards stay.
    await expect(dash.statValue('Total')).toBeVisible()
    await expect(app.window.getByRole('table')).toHaveCount(0)
    await expect(app.window.getByRole('textbox', { name: 'Search applications' })).toHaveCount(0)
    await expect(app.window.getByRole('combobox', { name: 'Filter by status' })).toHaveCount(0)
    await expect(app.window.getByRole('combobox', { name: 'Sort applications' })).toHaveCount(0)
    await expect(app.window.getByRole('complementary', { name: 'Pipeline and profile' }).getByText('Master profile')).toBeVisible()
  })

  test('each stat tile opens the Board on its column (#161)', async ({ app }) => {
    const dash = new Dashboard(app.window)
    const shell = new Shell(app.window)
    const board = new BoardPage(app.window)

    for (const [label, column] of [['Applied', 'applied'], ['Generated', 'ready'], ['Interviewing', 'interviewing'], ['Rejected', 'rejected'], ['Offer', 'offer']] as const) {
      await dash.statCard(label).click()
      await shell.expectActive('board')
      await expect(board.column(column)).toHaveAttribute('data-focus', 'true')
      await expect(board.column(column)).toBeInViewport()
      await expect(app.window.locator('[data-focus]')).toHaveCount(1)
      await shell.goTo('dashboard')
    }

    // Total opens the whole Board, no column picked.
    await dash.statCard('Total').click()
    await shell.expectActive('board')
    await expect(board.heading).toBeVisible()
    await expect(board.card('Senior Software Engineer')).toBeVisible()
    await expect(app.window.locator('[data-focus]')).toHaveCount(0)
  })

  test('the header greets by the master profile\'s first name; "Ready to apply" opens the result on the Board', async ({ app }) => {
    const dash = new Dashboard(app.window)
    const shell = new Shell(app.window)
    // The heading's text also holds its visually hidden "Dashboard:" prefix.
    await expect(dash.heading).toHaveText(/Good (morning|afternoon|evening), Alex\.$/)
    await expect(app.window.getByText(/^\d+ things? needs? you before the hunt moves on\.$/)).toBeVisible()

    // Acme is the only Generated application with a resume.pdf and a posting URL: its drawer opens on the Board.
    await expect(dash.needsYou).toContainText('1 ready to apply')
    await expect(dash.needsYou).not.toContainText('waiting for your reply')
    await dash.needsYou.getByRole('button', { name: 'Apply', exact: true }).click()
    await shell.expectActive('board')
    const board = new BoardPage(app.window)
    await expect(board.drawer).toBeVisible()
    await expect(board.drawer.getByRole('heading', { level: 2 })).toContainText('Acme')

    // Marking it applied there empties that card, and with nothing else waiting the strip goes away.
    await board.pick(board.drawer.getByRole('combobox', { name: 'Status' }), 'Applied')
    await board.closeDrawer()
    await shell.goTo('dashboard')
    await expect(dash.statValue('Applied')).toHaveText('2')
    await expect(dash.needsYou).toHaveCount(0)
    await expect(app.window.getByText('Nothing needs you right now. The hound keeps sniffing.')).toBeVisible()
  })
})

test.describe('workspace watch', () => {
  test('an application folder added on disk while the app runs is counted without pressing Refresh', async ({ app }) => {
    const dash = new Dashboard(app.window)
    await expect(dash.statValue('Total')).toHaveText('5')

    const folder = join(app.workspace!, 'sre', 'stark', 'st-1')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'job-description.md'),
      '# Site Reliability Engineer\n\nhttps://jobs.example.com/stark/1\n\nStark Industries needs an SRE for its Go services.\n'
    )
    await writeFile(join(folder, 'resume_data.json'), '{"contact":{"name":"Alex Rivera"}}\n')

    // fs.watch → debounce (600 ms) → applications:changed → the dashboard re-lists. No click involved.
    await expect(dash.statValue('Total')).toHaveText('6')
    await expect(dash.statValue('Generated')).toHaveText('3')

    // A new job description also changes the insights: the SRE posting is counted.
    await expect(app.window.getByText(/compared with 7 job descriptions/)).toBeVisible()
  })
})

test.describe('no applications', () => {
  // A first pipeline in which every job failed: no application folder, but a summary to look at.
  const failedPipeline: Preparer = {
    async prepare({ workspace }) {
      const ws = workspace!
      for (const role of ['software-engineer', 'backend-engineer', 'platform-engineer', 'data-engineer', 'frontend-engineer']) {
        await rm(join(ws, role), { recursive: true, force: true })
      }
      const summary: PipelineSummary = {
        id: 'p-20261005-060000-cccccc',
        startedAt: '2026-10-05T06:00:00.000Z',
        finishedAt: '2026-10-05T06:30:00.000Z',
        counts: { queued: 0, running: 0, needsReply: 0, unreviewed: 0, needsAttention: 0, approved: 0, discarded: 0, failed: 2, cancelled: 0, skipped: 0, total: 2 },
        costUsd: 0.42,
        items: [
          { jobId: 'pasted:a', title: 'Platform Engineer · Wayve', outcome: 'failed', error: 'The agent exited.' },
          { jobId: 'pasted:b', title: 'Data Engineer · Umbrella', outcome: 'failed', error: 'The agent exited.' }
        ],
        skipped: []
      }
      await mkdir(join(ws, '.huntgry'), { recursive: true })
      await writeFile(join(ws, '.huntgry/pipeline-summary.json'), JSON.stringify(summary, null, 2))
    }
  }
  test.use({ prepare: failedPipeline })

  test('the first-hunt page still shows the last pipeline, the profile insights and Refresh', async ({ app }) => {
    const page = app.window
    const dash = new Dashboard(page)
    await expect(dash.emptyState).toBeVisible()
    await expect(dash.heading).toHaveText(/Welcome to the den\.$/)
    await expect(dash.refreshButton).toBeVisible()

    const pipeline = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: 'Last unattended pipeline' }) })
    await expect(pipeline).toBeVisible()
    await expect(pipeline.getByText('Failed', { exact: true })).toBeVisible()
    await expect(pipeline.getByText('2 failed', { exact: true })).toBeVisible()
    await expect(pipeline.getByRole('button', { name: 'Open the queue' })).toBeVisible()
    await expect(new InsightsCard(page).card).toBeVisible()
  })
})
