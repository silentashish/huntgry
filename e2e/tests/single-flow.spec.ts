import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Preparer } from '../fixtures/app'
import { installFakeAgents } from '../fixtures/fake-agent'
import { savedJob, seedJobs } from '../fixtures/queue'
import { Shell } from '../pages/shell'
import { pastedFolder, TailorPage } from '../pages/tailor'

/**
 * #158: the automatic run is the only flow. A job pasted on the Tailor page and a saved job run
 * by the pipeline go the same way (saved job → queue → run with the saved job description →
 * verify gate → Review) and leave the same files: resume.pdf, resume_data.json,
 * build-report.json, job-description.md (copied from the file Huntgry saved, not retyped) and
 * tailoring-notes.md v2. Both land in Review as Unreviewed, with Apply locked until approved.
 */

const SAVED = savedJob({ id: 'pasted:e2e-flow', title: 'Platform Engineer', company: 'Initech' })
const PASTED = {
  description: '# Staff Engineer\n\nAcme Corp is hiring a Staff Engineer for its platform team. Go, PostgreSQL, Kubernetes.',
  company: 'Acme Corp',
  role: 'Staff Engineer'
}
const FILES = ['build-report.json', 'job-description.md', 'resume.pdf', 'resume_data.json', 'tailoring-notes.md']

const withSavedJob: Preparer = {
  async prepare({ sandbox, workspace }) {
    const env = await installFakeAgents(sandbox, { script: 'normal' })
    await seedJobs(workspace!, [SAVED])
    return env
  }
}

type Api = {
  huntgry: {
    pipeline: { start(input: unknown): Promise<{ id: string }> }
    queue: { state(): Promise<{ items: Array<{ jobId: string; status: string; outcome?: string; applicationId?: string; pipelineId?: string; runId: string | null }> }> }
  }
}

/** The run (under .huntgry/runs) that built `folder`. */
async function runOf(workspace: string, folder: string): Promise<string> {
  for (const id of await readdir(join(workspace, '.huntgry/runs'))) {
    const run = JSON.parse(await readFile(join(workspace, '.huntgry/runs', id, 'run.json'), 'utf8'))
    if (run.outputFolder === folder) return id
  }
  throw new Error(`no run built ${folder}`)
}

test.use({ workspace: 'demo', prepare: withSavedJob })

test('a Tailor-page run and a pipeline run leave the same files and both wait Unreviewed in Review (AC-2, AC-3)', async ({ app }) => {
  const shell = new Shell(app.window)
  await shell.goTo('tailor')
  const tailor = new TailorPage(app.window)

  // Entry point 1: the Tailor page (a pasted job becomes a saved job and a queue item).
  await tailor.start(PASTED)
  await tailor.expectStatus('Finished', 30_000)
  const pastedApp = pastedFolder(PASTED)

  // Entry point 2: the pipeline on a saved job.
  await app.window.evaluate(
    (jobId) =>
      (window as unknown as Api).huntgry.pipeline.start({
        jobIds: [jobId],
        options: { coverLetter: false, dateStyle: 'right' },
        concurrency: 1,
        skipTailored: false
      }),
    SAVED.id
  )
  const pipelineApp = 'platform-engineer/initech/e2e-flow'
  await expect
    .poll(async () => {
      const { items } = await app.window.evaluate(() => (window as unknown as Api).huntgry.queue.state())
      return items.map((i) => [i.jobId.startsWith('pasted:e2e') ? 'pipeline' : 'tailor', i.status, i.outcome, i.applicationId, !!i.pipelineId])
    }, { timeout: 30_000 })
    .toEqual(
      expect.arrayContaining([
        ['tailor', 'done', 'unreviewed', pastedApp, false],
        ['pipeline', 'done', 'unreviewed', pipelineApp, true]
      ])
    )

  for (const folder of [pastedApp, pipelineApp]) {
    const dir = join(app.workspace!, folder)
    expect((await readdir(dir)).filter((f) => FILES.includes(f)).sort(), folder).toEqual(FILES)
    expect(await readFile(join(dir, 'tailoring-notes.md'), 'utf8')).toContain('<!-- resume-tailor notes v2 -->')
    // The job description Huntgry saved before the run, copied as it is (the model never retyped it).
    const runId = await runOf(app.workspace!, folder)
    const saved = await readFile(join(app.workspace!, '.huntgry/runs', runId, 'job-description.md'), 'utf8')
    expect(await readFile(join(dir, 'job-description.md'), 'utf8')).toBe(saved)
    const events = await readFile(join(app.workspace!, '.huntgry/runs', runId, 'events.jsonl'), 'utf8')
    expect(events).toContain('Job description: saved at')
    expect(events).not.toContain('<job_description>')
  }

  // Both wait in Review, with the v2 sections.
  await shell.goTo('review')
  for (const title of ['Staff Engineer · Acme Corp', 'Platform Engineer · Initech']) {
    await app.window.getByRole('button', { name: new RegExp(title) }).first().click()
    await expect(app.window.getByRole('heading', { name: title, level: 3 })).toBeVisible()
    await expect(app.window.getByText('Reframings used', { exact: true }).first()).toBeVisible()
    await expect(app.window.getByText('Gaps left open', { exact: true }).first()).toBeVisible()
  }
})
