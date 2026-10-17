import type { Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Job } from '../../src/shared/jobs-types'
import type { PipelineRecord } from '../../src/shared/pipeline-types'
import { expect, spawnedChildren, test, type AppFixture, type Preparer } from '../fixtures/app'
import { fakeAgents, installFakeAgents } from '../fixtures/fake-agent'
import { savedJob, seedJobs, seedQueue } from '../fixtures/queue'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'

/**
 * #134: jobs selected on the Jobs page and started through "Run unattended" must actually start
 * (the pipeline card said "Running" while every item stayed "Queued" and no agent was spawned).
 * Each test drives the real flow (selection bar → modal → Continue → Start unattended) against the
 * scripted agents and checks that items leave "queued" and the fake agent records turns.
 */

const COMPANIES = ['Initech', 'Globex', 'Umbrella', 'Hooli', 'Vandelay', 'Soylent', 'Tyrell', 'Cyberdyne']
const JOBS = COMPANIES.map((company, n) =>
  savedJob({ id: `pasted:e2e-u-${n}`, title: `Platform Engineer ${n + 1}`, company })
)

function withJobs(jobs: Job[], extra?: (workspace: string) => Promise<void>): Preparer {
  return {
    async prepare({ sandbox, workspace }) {
      const env = await installFakeAgents(sandbox, { script: 'slow', slowMs: 1500 })
      await seedJobs(workspace!, jobs)
      await extra?.(workspace!)
      return env
    }
  }
}

type QueueState = { paused: boolean; concurrency: number; items: Array<{ status: string; jobId: string; pipelineId?: string }> }
type PipelineState = { id: string; status: string; counts: Record<string, number> } | null
type Api = {
  huntgry: {
    queue: { state(): Promise<QueueState> }
    pipeline: { state(): Promise<PipelineState>; stop(): Promise<PipelineState> }
    runner: { start(p: unknown): Promise<{ id: string }> }
  }
}

const queueState = (page: Page) => page.evaluate(() => (window as unknown as Api).huntgry.queue.state())
const pipelineState = (page: Page) => page.evaluate(() => (window as unknown as Api).huntgry.pipeline.state())

/** Selection bar → "Run unattended" → Continue → "Start unattended (n)", with the modal's defaults (2 at a time, cover letter, skip tailored). */
async function startUnattended(app: AppFixture, jobs: Job[]): Promise<void> {
  await new Shell(app.window).goTo('jobs')
  const page = new JobsPage(app.window)
  await page.show('All')
  for (const job of jobs) await page.select(job.title).check()
  await expect(page.selectionBar).toContainText(`${jobs.length} selected`)
  await page.selectionBar.getByRole('button', { name: 'Run unattended' }).click()
  const modal = app.window.getByRole('dialog', { name: `Tailor ${jobs.length} jobs` })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('radio', { name: 'Run unattended' })).toBeChecked()
  await modal.getByRole('button', { name: 'Continue' }).click()
  const start = modal.getByRole('button', { name: `Start unattended (${jobs.length})` })
  await expect(start).toBeEnabled({ timeout: 15_000 })
  await start.click()
  await expect(modal).toBeHidden()
}

/** The pipeline's items leave "queued" (a run starts) and the fake agent records turns. */
async function expectRunsStart(app: AppFixture, pipelineId: string, turnsBefore = 0): Promise<void> {
  await expect
    .poll(
      async () => (await queueState(app.window)).items.filter((i) => i.pipelineId === pipelineId && i.status !== 'queued').length,
      { timeout: 20_000, message: 'unattended items never left "queued"' }
    )
    .toBeGreaterThan(0)
  await expect.poll(async () => (await fakeAgents(app).turns()).length, { timeout: 20_000 }).toBeGreaterThan(turnsBefore)
}

/** Stops the pipeline and waits until nothing the app spawned is left. */
async function stopAndDrain(app: AppFixture): Promise<void> {
  await app.window.evaluate(() => (window as unknown as Api).huntgry.pipeline.stop())
  await expect.poll(async () => (await pipelineState(app.window))?.status, { timeout: 30_000 }).toBe('finished')
  await expect.poll(() => spawnedChildren(app.electronApp.process().pid!), { timeout: 30_000 }).toEqual([])
}

test.describe('Run unattended from the Jobs page (#134)', () => {
  test.describe('three jobs', () => {
    test.use({ workspace: 'demo', prepare: withJobs(JOBS.slice(0, 3)) })

    test('the runs start', async ({ app }) => {
      await startUnattended(app, JOBS.slice(0, 3))
      const p = await pipelineState(app.window)
      expect(p?.status).toBe('running')
      await expectRunsStart(app, p!.id)
      await stopAndDrain(app)
    })
  })

  test.describe('eight jobs, 2 at a time', () => {
    test.use({ workspace: 'demo', prepare: withJobs(JOBS) })

    test('the runs start', async ({ app }) => {
      await startUnattended(app, JOBS)
      const p = await pipelineState(app.window)
      await expectRunsStart(app, p!.id)
      await stopAndDrain(app)
    })

    test('a pipeline started and stopped, then a new one in the same session: its runs start', async ({ app }) => {
      await startUnattended(app, JOBS.slice(0, 4))
      const first = await pipelineState(app.window)
      await expectRunsStart(app, first!.id)
      await stopAndDrain(app)
      const turns = (await fakeAgents(app).turns()).length

      await startUnattended(app, JOBS.slice(4))
      const second = await pipelineState(app.window)
      expect(second!.id).not.toBe(first!.id)
      await expectRunsStart(app, second!.id, turns)
      await stopAndDrain(app)
    })

    test('with two Tailor-page runs waiting for a reply: the runs start', async ({ app }) => {
      for (const n of [1, 2]) {
        await app.window.evaluate(
          (n) =>
            (window as unknown as Api).huntgry.runner.start({
              jobDescription: 'Acme is hiring a Backend Engineer. Requirements: Go.',
              company: 'Acme',
              role: `Backend Engineer ${n}`,
              jobId: `manual-${n}`,
              coverLetter: false,
              dateStyle: 'right',
              source: 'manual'
            }),
          n
        )
      }
      // Both wait for their reply with their process alive (they hold both slots).
      await expect.poll(async () => (await fakeAgents(app).turns()).filter((t) => t.end !== null).length, { timeout: 20_000 }).toBe(2)
      const turns = (await fakeAgents(app).turns()).length
      await startUnattended(app, JOBS)
      const p = await pipelineState(app.window)
      await expectRunsStart(app, p!.id, turns)
      await stopAndDrain(app)
    })

    test('after a quit that was cancelled (a window refused to close): the runs start', async ({ app }) => {
      // Cmd+Q whose window close is refused, as "Keep Editing" on unsaved profile edits does: `before-quit`
      // has already stopped the pipeline, the queue and the runs, but the app stays open.
      await app.electronApp.evaluate(({ app: electronApp, BrowserWindow }) => {
        const g = globalThis as unknown as { refused: number }
        g.refused = 0
        for (const win of BrowserWindow.getAllWindows())
          win.once('close', (event) => {
            g.refused++
            event.preventDefault()
          })
        setTimeout(() => electronApp.quit(), 0)
      })
      await expect
        .poll(() => app.electronApp.evaluate(() => (globalThis as unknown as { refused: number }).refused), { timeout: 15_000 })
        .toBe(1)
      await expect(app.window.locator('body')).toBeVisible()

      await startUnattended(app, JOBS)
      const p = await pipelineState(app.window)
      expect(p?.status).toBe('running')
      await expectRunsStart(app, p!.id)
      await stopAndDrain(app)
    })
  })

  test.describe('a workspace with a finished pipeline', () => {
    const OLD = JOBS.slice(0, 2)
    const NEW = JOBS.slice(2)
    const record: PipelineRecord = {
      id: 'p-20260930-110000-000000',
      status: 'finished',
      options: {
        coverLetter: true,
        dateStyle: 'right',
        agent: 'claude',
        concurrency: 2,
        resumeAfterRestart: true,
        skipTailored: true,
        stallMinutes: 20
      },
      itemIds: [],
      skipped: [],
      limits: {},
      unparsedStrikes: 0,
      startedAt: '2026-09-30T11:00:00.000Z',
      finishedAt: '2026-09-30T11:30:00.000Z',
      runCosts: {},
      estimateMsPerJob: null
    } as PipelineRecord
    test.use({
      workspace: 'demo',
      prepare: withJobs(JOBS, async (ws) => {
        // seedQueue numbers its items q-20260930-120000-00000n.
        record.itemIds = OLD.map((_, n) => `q-20260930-120000-${String(n).padStart(6, '0')}`)
        await seedQueue(
          ws,
          OLD.map((job) => ({ job, status: 'done' as const, unattended: true as const, pipelineId: record.id, outcome: 'unreviewed' as const })),
          2,
          record
        )
        await mkdir(join(ws, '.huntgry'), { recursive: true })
        await writeFile(
          join(ws, '.huntgry/pipeline-summary.json'),
          JSON.stringify({ id: record.id, startedAt: record.startedAt, finishedAt: record.finishedAt, counts: {}, costUsd: 0, items: [], skipped: [] })
        )
      })
    })

    test('a new pipeline: its runs start', async ({ app }) => {
      await startUnattended(app, NEW)
      const p = await pipelineState(app.window)
      expect(p!.id).not.toBe(record.id)
      await expectRunsStart(app, p!.id)
      await stopAndDrain(app)
    })
  })
})
