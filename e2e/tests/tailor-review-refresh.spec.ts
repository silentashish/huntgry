import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PipelineRecord, PipelineSummary } from '../../src/shared/pipeline-types'
import { expect, test, type Preparer } from '../fixtures/app'
import { savedJob, seedJobs, seedQueue } from '../fixtures/queue'
import { seedResult, seedReviews } from '../fixtures/review'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'

/**
 * #72: a decision on the Review page reaches the Tailor page. A finished
 * unattended pipeline with one Unreviewed result, plus an Unreviewed result of
 * an earlier pipeline in the Tailoring queue, are seeded as the pipeline leaves
 * them (queue.json, the application folders, main's review store). Approving
 * the first and discarding the second must clear their Unreviewed badges, their
 * Review buttons, the "ready for your review" banner and the Dashboard card's
 * count, without a restart.
 */

const PIPELINE = 'p-20261005-060000-aaaaaa'
const NOW = savedJob({ id: 'pasted:e2e-72-now', title: 'Forward Deployed AI Engineer', company: 'Bertram Capital' })
const EARLIER = savedJob({ id: 'pasted:e2e-72-earlier', title: 'Platform Engineer', company: 'Wayve' })
const RESULTS = {
  now: { folder: 'forward-deployed-ai-engineer/bertram-capital/e2e-72-now', runId: '20261005-060100-aaaaaa', job: NOW },
  earlier: { folder: 'platform-engineer/wayve/e2e-72-earlier', runId: '20261004-060100-bbbbbb', job: EARLIER }
}

const label = (job: { title: string; company: string }) => `${job.title} · ${job.company}`

const record: PipelineRecord = {
  id: PIPELINE,
  status: 'finished',
  options: {
    coverLetter: false,
    dateStyle: 'right',
    agent: 'claude',
    concurrency: 1,
    resumeAfterRestart: false,
    skipTailored: true,
    stallMinutes: 20
  },
  // seedQueue numbers the items in order: the second one is this pipeline's.
  itemIds: ['q-20260930-120000-000001'],
  skipped: [],
  limits: {},
  unparsedStrikes: 0,
  startedAt: '2026-10-05T06:00:00.000Z',
  finishedAt: '2026-10-05T06:20:00.000Z',
  runCosts: {},
  estimateMsPerJob: null
}

const summary: PipelineSummary = {
  id: PIPELINE,
  startedAt: record.startedAt,
  finishedAt: record.finishedAt!,
  counts: { queued: 0, running: 0, needsReply: 0, unreviewed: 1, needsAttention: 0, approved: 0, discarded: 0, failed: 0, cancelled: 0, skipped: 0, total: 1 },
  costUsd: 1.15,
  items: [{ jobId: NOW.id, title: label(NOW), outcome: 'unreviewed', applicationId: RESULTS.now.folder }],
  skipped: []
}

const finishedPipeline: Preparer = {
  async prepare({ sandbox, workspace }) {
    const ws = workspace!
    await seedJobs(ws, [NOW, EARLIER])
    await seedQueue(
      ws,
      [
        { job: EARLIER, status: 'done', runId: RESULTS.earlier.runId, unattended: true, pipelineId: 'p-20261004-060000-bbbbbb', outcome: 'unreviewed', applicationId: RESULTS.earlier.folder },
        { job: NOW, status: 'done', runId: RESULTS.now.runId, unattended: true, pipelineId: PIPELINE, outcome: 'unreviewed', applicationId: RESULTS.now.folder }
      ],
      1,
      record
    )
    for (const r of Object.values(RESULTS)) await seedResult(ws, r.folder, { role: r.job.title, company: r.job.company, runId: r.runId })
    await seedReviews(sandbox.userData, ws, {
      [RESULTS.now.folder]: { state: 'unreviewed', runId: RESULTS.now.runId },
      [RESULTS.earlier.folder]: { state: 'unreviewed', runId: RESULTS.earlier.runId }
    })
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    await writeFile(join(ws, '.huntgry/pipeline-summary.json'), JSON.stringify(summary, null, 2))
  }
}

test.use({ workspace: 'demo', prepare: finishedPipeline })

test('approving and discarding on the Review page clears Unreviewed on the Tailor page and the Dashboard card', async ({ app }) => {
  const shell = new Shell(app.window)
  const page = app.window
  await shell.goTo('tailor')
  const tailor = new TailorPage(page)

  // Before: both results wait for review.
  await expect(tailor.pipelinePanel).toBeVisible()
  await expect(tailor.reviewBanner).toContainText('1 result ready for your review')
  await expect(tailor.pipelineCount('1 unreviewed')).toBeVisible()
  const nowRow = tailor.pipelineRow(label(NOW))
  await expect(nowRow.getByText('Unreviewed', { exact: true })).toBeVisible()
  const earlierRow = tailor.queueRow(label(EARLIER))
  await expect(earlierRow.getByText('Unreviewed', { exact: true })).toBeVisible()

  // Approve the pipeline's result on the Review page.
  await nowRow.getByRole('button', { name: 'Review', exact: true }).click()
  await page.getByRole('button', { name: /^Approve/ }).click()

  // Back on Tailor (whether the decision lands before or after it mounts, main pushes the change).
  await shell.goTo('tailor')
  await expect(nowRow.getByText('Approved', { exact: true })).toBeVisible()
  await expect(nowRow.getByText('Unreviewed', { exact: true })).toHaveCount(0)
  await expect(nowRow.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
  await expect(nowRow.getByRole('button', { name: 'Open run' })).toBeVisible()
  await expect(tailor.reviewBanner).toHaveCount(0)
  await expect(tailor.pipelineCount('1 unreviewed')).toHaveCount(0)
  await expect(tailor.pipelineCount('1 approved')).toBeVisible()
  // The earlier pipeline's row is still waiting.
  await expect(earlierRow.getByText('Unreviewed', { exact: true })).toBeVisible()

  // Discard the earlier result.
  await earlierRow.getByRole('button', { name: 'Review', exact: true }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByText('Archive this result (files are kept)?')).toBeVisible()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()

  await shell.goTo('tailor')
  await expect(earlierRow.getByText('Discarded', { exact: true })).toBeVisible()
  await expect(earlierRow.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)

  // The Dashboard's last-pipeline card no longer counts the approved result as ready to review.
  await shell.goTo('dashboard')
  const card = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: 'Last unattended pipeline' }) })
  await expect(card).toBeVisible()
  await expect(card.getByText('1 approved', { exact: true })).toBeVisible()
  await expect(card.getByText(/ready to review/)).toHaveCount(0)
  await expect(card.getByRole('button', { name: /^Review \d+ result/ })).toHaveCount(0)
})
