import { expect, test, type Preparer } from '../fixtures/app'
import { fakeAgents, installFakeAgents, type FakeAgentOptions } from '../fixtures/fake-agent'
import { boardOnlyJob, readQueue, savedJob, seedJobs, seedQueue, type SeedQueueItem } from '../fixtures/queue'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'

/**
 * The bulk tailoring queue against the scripted agents: what "Tailor all" on
 * the Jobs page leaves behind (`.huntgry/jobs`, `.huntgry/queue.json`) is
 * seeded before launch, so the queue opens paused, the way it does after any
 * restart. Every job stops at the approval step, which frees its slot.
 */

const ONE = savedJob({ id: 'pasted:e2e-one', title: 'Platform Engineer', company: 'Initech' })
const TWO = savedJob({ id: 'pasted:e2e-two', title: 'Data Engineer', company: 'Globex' })
const THREE = savedJob({ id: 'pasted:e2e-three', title: 'SRE', company: 'Umbrella' })
const SNIPPET = boardOnlyJob({ id: 'indeed:e2e-snippet', title: 'Backend Developer', company: 'Vandelay' })

const label = (job: { title: string; company: string }) => `${job.title} · ${job.company}`

/** Fakes plus the seeded jobs and queue. */
function queued(items: SeedQueueItem[], concurrency: number, fakes: FakeAgentOptions = {}): Preparer {
  return {
    async prepare({ sandbox, workspace }) {
      const env = await installFakeAgents(sandbox, fakes)
      await seedJobs(workspace!, [...new Set(items.map((i) => i.job))])
      await seedQueue(workspace!, items, concurrency)
      return env
    }
  }
}

async function openTailor(window: import('@playwright/test').Page): Promise<TailorPage> {
  await new Shell(window).goTo('tailor')
  const tailor = new TailorPage(window)
  await expect(tailor.queuePanel).toBeVisible()
  return tailor
}

test.describe('two queued jobs', () => {
  test.use({ workspace: 'demo', prepare: queued([{ job: ONE }, { job: TWO }], 2) })

  test('start after Resume, both stop at the approval step, and a reply opens the run', async ({ app }) => {
    const fakes = fakeAgents(app)
    const tailor = await openTailor(app.window)
    await expect(tailor.queueCount('2 queued')).toBeVisible()
    await expect(tailor.queuePausedNote).toBeVisible()
    await expect(tailor.concurrencySelect).toHaveValue('2 at a time')
    expect(await fakes.runs()).toEqual([])

    await tailor.queueResumeButton.click()
    await expect(tailor.queueCount('2 needs your reply')).toBeVisible({ timeout: 20_000 })
    await expect(tailor.queuePausedNote).toHaveCount(0)
    expect((await fakes.runs()).map((r) => r.agent)).toEqual(['claude', 'claude'])
    await expect(tailor.waitingNote).toHaveText('2 runs waiting for your reply')

    // "Reply" on a row opens its run; the approval builds and the row shows it.
    await tailor.queueRow(label(ONE)).getByRole('button', { name: 'Reply' }).click()
    await tailor.expectStatus('Waiting for you')
    await expect(tailor.runTitle(label(ONE))).toBeVisible()
    await tailor.reply('Approved')
    await expect(tailor.outputLine('platform-engineer/initech/e2e-one')).toBeVisible()
    await expect(tailor.queueRow(label(ONE)).getByText('Resume built')).toBeVisible()
    // The job's posting URL is recorded with the application, for the dashboard.
    const { items } = await readQueue(app.workspace!)
    expect(items.map((i) => i.status)).toEqual(['needs-reply', 'needs-reply'])
    expect(items[0].built).toBe(true)
    expect(items.every((i) => i.runId)).toBe(true)
  })
})

test.describe('concurrency', () => {
  test.use({ workspace: 'demo', prepare: queued([{ job: ONE }, { job: TWO }, { job: THREE }], 2, { script: 'slow', slowMs: 2500 }) })

  test('at most "2 at a time" work: the third job starts only when a slot frees', async ({ app }) => {
    const fakes = fakeAgents(app)
    const tailor = await openTailor(app.window)
    await expect(tailor.queueCount('3 queued')).toBeVisible()
    await tailor.queueResumeButton.click()
    await expect(tailor.queueCount('3 needs your reply')).toBeVisible({ timeout: 45_000 })

    const turns = (await fakes.turns()).sort((a, b) => a.start - b.start)
    expect(turns).toHaveLength(3)
    expect(turns.every((t) => t.end !== null)).toBe(true)
    // Never more than two turns under way at once (checked at every start, where the count can only rise).
    for (const t of turns) {
      const active = turns.filter((o) => o.start <= t.start && o.end! > t.start)
      expect(active.length).toBeLessThanOrEqual(2)
    }
    // Each slow turn takes ≥ 3 pauses (7.5 s); the third job began only after one of the first two ended,
    // later than the 2 s spawn gap alone would have allowed.
    const firstEnd = Math.min(turns[0].end!, turns[1].end!)
    expect(turns[2].start).toBeGreaterThanOrEqual(firstEnd - 50)
    expect(turns[2].start - turns[1].start).toBeGreaterThan(4000)
  })
})

test.describe('a job with only the board summary', () => {
  test.use({ workspace: 'demo', prepare: queued([{ job: SNIPPET }, { job: TWO }], 2) })

  test('is skipped with the note; the other job runs', async ({ app }) => {
    const fakes = fakeAgents(app)
    const tailor = await openTailor(app.window)
    await tailor.queueResumeButton.click()
    const row = tailor.queueRow(label(SNIPPET))
    await expect(row.getByText('Failed', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText('Indeed shows full job descriptions only after a human check.')
    await expect(row).toContainText('Open the posting, add its description with "Paste a job" on the Jobs page, and tailor that job.')
    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(tailor.queueRow(label(TWO)).getByText('Needs your reply', { exact: true })).toBeVisible({ timeout: 20_000 })
    // Only one agent was ever started, for the job with a description.
    expect((await fakes.runs()).map((r) => r.agent)).toEqual(['claude'])
    const { items } = await readQueue(app.workspace!)
    expect(items.find((i) => i.jobId === SNIPPET.id)).toMatchObject({ status: 'failed', runId: null })
  })
})

test.describe('per-job agent', () => {
  test.use({ workspace: 'demo', prepare: queued([{ job: ONE }, { job: TWO }], 2) })

  test('can be changed while the job waits in the queue, and that agent is started', async ({ app }) => {
    const fakes = fakeAgents(app)
    const tailor = await openTailor(app.window)
    await tailor.pickQueueAgent(label(TWO), 'Codex')
    await expect.poll(async () => (await readQueue(app.workspace!)).items.map((i) => i.agent)).toEqual(['claude', 'codex'])

    await tailor.queueResumeButton.click()
    await expect(tailor.queueCount('2 needs your reply')).toBeVisible({ timeout: 20_000 })
    // Started jobs show their agent as a badge, not a select.
    await expect(tailor.queueAgentSelect(label(TWO))).toHaveCount(0)
    await expect(tailor.queueRow(label(TWO)).getByText('Codex', { exact: true })).toBeVisible()
    await expect(tailor.queueRow(label(ONE)).getByText('Claude', { exact: true })).toBeVisible()
    expect((await fakes.runs()).map((r) => r.agent).sort()).toEqual(['claude', 'codex'])
  })
})

test.describe('after a relaunch', () => {
  test.use({ workspace: 'demo', prepare: queued([{ job: ONE }, { job: TWO }], 1, { script: 'slow', slowMs: 3000 }) })

  test('the queue is paused, the interrupted job is marked, and Resume starts the rest', async ({ app }) => {
    const fakes = fakeAgents(app)
    let tailor = await openTailor(app.window)
    await tailor.queueResumeButton.click()
    // One slot: the first job is working, the second still queued, when the app quits.
    await expect(tailor.queueRow(label(ONE)).getByText('Working', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(tailor.queueRow(label(TWO)).getByText('Queued', { exact: true })).toBeVisible()
    await expect.poll(async () => (await fakes.runs()).length).toBe(1)

    await app.relaunch()
    tailor = await openTailor(app.window)
    await expect(tailor.queuePausedNote).toBeVisible()
    const interrupted = tailor.queueRow(label(ONE))
    await expect(interrupted.getByText('Failed', { exact: true })).toBeVisible()
    await expect(interrupted).toContainText('Huntgry was closed while this job was starting or running. Retry it.')
    await expect(tailor.queueRow(label(TWO)).getByText('Queued', { exact: true })).toBeVisible()
    // Nothing started on its own.
    expect((await fakes.runs()).length).toBe(1)

    await fakes.setScript('normal')
    await tailor.queueResumeButton.click()
    await expect(tailor.queueRow(label(TWO)).getByText('Needs your reply', { exact: true })).toBeVisible({ timeout: 20_000 })
    expect((await fakes.runs()).length).toBe(2)
    // The interrupted job can be retried; it starts a new run.
    await interrupted.getByRole('button', { name: 'Retry' }).click()
    await expect(tailor.queueRow(label(ONE)).getByText('Needs your reply', { exact: true })).toBeVisible({ timeout: 20_000 })
    expect((await fakes.runs()).length).toBe(3)
  })
})
