import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { fakeAgents, withFakeAgents } from '../fixtures/fake-agent'
import { Shell } from '../pages/shell'
import { pastedFolder, TailorPage } from '../pages/tailor'

/**
 * #159: Review rejects reframings instead of approving them. A run uses its bridges; on the Review
 * page the user rejects one, with a better wording, and presses Re-run. The rejection is a
 * reframing rule: the re-run's message (and, for a new process, its system prompt) carries the
 * rejected wording as a wording to avoid and the better one as preferred, and the rebuilt resume
 * no longer has the rejected wording. Settings → Reframing rules lists the rule and removes it.
 *
 * `HUNTGRY_SHOTS=<dir>` saves the screenshots of the change's docs there.
 */

const JOB = {
  description: '# Staff Engineer\n\nAcme Corp is hiring a Staff Engineer for its platform team. Go, PostgreSQL, Kubernetes.',
  company: 'Acme Corp',
  role: 'Staff Engineer'
}
const FACT = 'Led the migration of the billing service to Go'
const REJECTED = 'Owned the platform migration of billing to Go for acme-corp'
const BETTER = 'Moved the billing service to Go, end to end'
const SHOTS = process.env.HUNTGRY_SHOTS

test.use({ workspace: 'demo', prepare: withFakeAgents({ script: 'normal' }) })

/** The run (under .huntgry/runs) that built `folder`. */
async function runOf(workspace: string, folder: string): Promise<string> {
  for (const id of await readdir(join(workspace, '.huntgry/runs'))) {
    const run = JSON.parse(await readFile(join(workspace, '.huntgry/runs', id, 'run.json'), 'utf8'))
    if (run.outputFolder === folder) return id
  }
  throw new Error(`no run built ${folder}`)
}

test('Reject → Re-run rebuilds the resume without the rejected wording, with the rule passed to the run (AC-3)', async ({ app }) => {
  const page = app.window
  const shell = new Shell(page)
  await shell.goTo('tailor')
  const tailor = new TailorPage(page)
  await tailor.start(JOB)
  await tailor.expectStatus('Finished', 30_000)
  const folder = pastedFolder(JOB)
  const dir = join(app.workspace!, folder)
  const bullet = async () => JSON.parse(await readFile(join(dir, 'resume_data.json'), 'utf8')).experience[0].bullets[0] as string
  expect(await bullet()).toBe(REJECTED)

  // Review: the reframing used, with Reject.
  await shell.goTo('review')
  const title = 'Staff Engineer · Acme Corp'
  await page.getByRole('button', { name: new RegExp(title) }).first().click()
  await expect(page.getByRole('heading', { name: title, level: 3 })).toBeVisible()
  await expect(page.getByText(REJECTED, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reject R1' }).click()
  await page.getByLabel('Better wording (optional)').fill(BETTER)
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'review-reject-form.png') })
  await page.getByRole('button', { name: 'Reject R1' }).click()

  // The rule shows on the reframing; Re-run names what it leaves out.
  await expect(page.getByText('Rejected', { exact: true })).toBeVisible()
  await expect(page.getByText(BETTER, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo the rejection of R1' })).toBeVisible()
  await expect(page.getByText(/with your reframing rules \(without R1\)/)).toBeVisible()
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'review-rejected.png') })

  const runsBefore = (await fakeAgents(app).runs()).length
  await page.getByRole('button', { name: 'Re-run', exact: true }).click()

  // The rebuilt resume: the better wording, never the rejected one.
  await expect.poll(bullet, { timeout: 30_000 }).toBe(BETTER)
  const notes = await readFile(join(dir, 'tailoring-notes.md'), 'utf8')
  expect(notes).toContain(`- Wording: ${BETTER}`)
  expect(notes).not.toContain(REJECTED)
  expect(await readFile(join(dir, 'resume.pdf'), 'latin1')).not.toContain(REJECTED)

  // The rule went to the run: in the re-run's message...
  const runId = await runOf(app.workspace!, folder)
  const avoid = `WORDINGS TO AVOID (JSON, newest first): ${JSON.stringify([{ sourceFact: FACT, wording: REJECTED }])}`
  const preferred = `PREFERRED WORDINGS (JSON, newest first): ${JSON.stringify([{ sourceFact: FACT, wording: BETTER }])}`
  await expect
    .poll(async () => {
      const events = await readFile(join(app.workspace!, '.huntgry/runs', runId, 'events.jsonl'), 'utf8')
      return [events.includes(JSON.stringify(avoid).slice(1, -1)), events.includes(JSON.stringify(preferred).slice(1, -1)), events.includes(`Rejected wording: ${REJECTED}`)]
    })
    .toEqual([true, true, true])
  // ...and in the system prompt of the agent process resumed for it (the finished run's process had exited).
  const resumed = (await fakeAgents(app).runs()).slice(runsBefore)
  expect(resumed.length).toBeGreaterThan(0)
  for (const r of resumed) {
    const args = r.args ?? []
    const prompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(prompt).toContain(avoid)
    expect(prompt).toContain(preferred)
  }

  // Back in Review (reopened: the detail on screen is the revision the re-run was sent from), the new
  // revision shows the better wording as the reframing used; keep it and approve.
  await page.getByRole('button', { name: new RegExp(title) }).first().click()
  const keep = page.getByRole('checkbox', { name: `Keep: ${BETTER}` })
  await expect(keep).toBeVisible({ timeout: 30_000 })
  await keep.check()
  await page.getByRole('button', { name: /^Approve/ }).click()
  await expect(page.getByRole('button', { name: 'Reframing rules · 2' })).toBeVisible()

  // Settings → Reframing rules: the preferred wording and the rejected one (with its better wording), each removable.
  await page.getByRole('button', { name: /^Reframing rules/ }).click()
  await expect(page.getByRole('region', { name: 'Preferred wordings' }).getByText(BETTER)).toBeVisible()
  const card = page.getByRole('region', { name: 'Rejected wordings' })
  await expect(card.getByText(REJECTED)).toBeVisible()
  await expect(card.getByText(BETTER)).toBeVisible()
  if (SHOTS) {
    await page.getByRole('region', { name: 'Preferred wordings' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, 'settings-reframing-rules.png') })
  }
  await card.getByRole('button', { name: `Remove rule: ${REJECTED}` }).click()
  await expect(page.getByRole('region', { name: 'Rejected wordings' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Preferred wordings' })).toBeVisible()
})
