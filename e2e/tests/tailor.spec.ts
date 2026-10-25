import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { fakeAgents, withFakeAgents } from '../fixtures/fake-agent'
import { Shell } from '../pages/shell'
import { SettingsPage } from '../pages/settings'
import { openedPaths, pastedFolder, stubOpenPath, TailorPage } from '../pages/tailor'

/**
 * A tailoring run from the form to the built files, driven through the app's
 * real runner against the scripted agents (e2e/fixtures/fake-agent): the
 * pre-run check, the job saved and queued (#158), the streamed transcript of a
 * run that goes to the end without asking, the finished files, a failing agent,
 * a quit mid-run, and which agent gets started.
 */

const JOB = {
  description: '# Staff Engineer\n\nAcme Corp is hiring a Staff Engineer for its platform team. Go, PostgreSQL, Kubernetes.',
  company: 'Acme Corp',
  role: 'Staff Engineer'
}
const TITLE = 'Staff Engineer · Acme Corp'
const FOLDER = pastedFolder(JOB)
const FILES = ['build-report.json', 'job-description.md', 'resume.pdf', 'resume_data.json', 'tailoring-notes.md']

/** The run ids on disk, oldest first. */
async function runIds(workspace: string): Promise<string[]> {
  return (await readdir(join(workspace, '.huntgry/runs')).catch(() => [])).sort()
}

async function readRun(workspace: string, id: string): Promise<{ status: string; sessionId: string | null; error?: string; outputFolder: string | null; outputFiles: string[] }> {
  return JSON.parse(await readFile(join(workspace, '.huntgry/runs', id, 'run.json'), 'utf8'))
}

test.describe('tailor with the fake agents', () => {
  test.use({ workspace: 'demo', prepare: withFakeAgents({ script: 'slow', slowMs: 400 }) })

  test('the pre-run check passes: no warning on the form and Start is enabled once a job is pasted', async ({ app }) => {
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await expect(tailor.agentChoice('Claude')).toHaveAccessibleName('Claude (default)')
    await expect(tailor.startButton).toBeDisabled()
    await tailor.jobDescription.fill(JOB.description)
    await expect(tailor.startButton).toBeEnabled()
    await expect(tailor.formAlert).toHaveCount(0)
  })

  test('a pasted job is saved and queued; its run streams, builds without asking, finishes and waits in Review (#158)', async ({ app }) => {
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await tailor.start(JOB)

    // The run opens once the queue starts it; its first message names the saved job description, not its text.
    await expect(tailor.runTitle(TITLE)).toBeVisible({ timeout: 15_000 })
    await expect(app.window.getByText('Job description: saved at', { exact: false }).first()).toBeVisible()
    await expect(app.window.getByText('Acme Corp is hiring a Staff Engineer', { exact: false })).toHaveCount(0)
    await expect(app.window.getByText('Gap analysis for staff-engineer at acme-corp', { exact: false })).toBeVisible()
    await tailor.expectStatus('Claude is working')
    await expect(tailor.toolRow('Read')).toBeVisible()
    // No question, no approval: the same turn builds.
    await expect(tailor.toolRow('Bash')).toBeVisible()
    await expect(tailor.turnResults).toHaveCount(1)
    await expect(app.window.getByText(/Do you approve|approve these bullets/i)).toHaveCount(0)
    // The verify gate settles the result and the queue ends the run.
    await tailor.expectStatus('Finished', 30_000)
    await expect(tailor.waitingNote).toHaveCount(0)
    await expect(tailor.outputLine(FOLDER)).toHaveText(`${FOLDER}/ · ${FILES.join(', ')}`)
    const pdf = join(app.workspace!, FOLDER, 'resume.pdf')
    expect(await readFile(pdf, 'utf8')).toMatch(/^%PDF-1\.4/)
    // Apply waits for the Review page.
    await expect(tailor.outputButton('Apply')).toBeDisabled()
    await expect(tailor.applyReason).toContainText('Unreviewed')

    // The job description was saved by Huntgry before the run and copied into the folder (build.py --jd).
    const [id] = await runIds(app.workspace!)
    const saved = await readFile(join(app.workspace!, '.huntgry/runs', id, 'job-description.md'), 'utf8')
    expect(saved).toContain('Acme Corp is hiring a Staff Engineer')
    expect(await readFile(join(app.workspace!, FOLDER, 'job-description.md'), 'utf8')).toBe(saved)
    expect(await readFile(join(app.workspace!, FOLDER, 'tailoring-notes.md'), 'utf8')).toContain('<!-- resume-tailor notes v2 -->')
    expect(await readRun(app.workspace!, id)).toMatchObject({ status: 'finished', outputFolder: FOLDER, outputFiles: FILES })

    // "Resume" opens the PDF through the OS (stubbed: the machine's viewer must not open).
    await stubOpenPath(app.electronApp)
    await tailor.outputButton('Resume').click()
    await expect.poll(() => openedPaths(app.electronApp)).toEqual([pdf])

    // The pasted job is a saved job now.
    const shell = new Shell(app.window)
    await shell.goTo('jobs')
    await expect(app.window.getByText('Staff Engineer', { exact: true }).first()).toBeVisible()
    // The dashboard lists the new application next to the demo ones.
    await shell.goTo('dashboard')
    await expect(app.window.getByText('Acme Corp', { exact: true }).first()).toBeVisible()
  })

  test('a failing agent shows the error state and the run stays in .huntgry/runs', async ({ app }) => {
    const fakes = fakeAgents(app)
    await fakes.setScript('fail')
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await tailor.start(JOB)
    await tailor.expectStatus('Failed')
    await expect(tailor.errorAlert).toContainText('Claude stopped with an error')
    await expect(tailor.errorAlert).toContainText('boom: simulated agent failure')
    await expect(app.window.getByText(/^Claude stopped: /)).toBeVisible()
    await expect(tailor.runEntry(TITLE)).toContainText('Failed')
    // A failed run with a session can still be continued; the box says so.
    await expect(tailor.replyBox).toHaveAttribute('placeholder', /Continue this conversation/)

    const [id] = await runIds(app.workspace!)
    await expect.poll(async () => (await readRun(app.workspace!, id)).status).toBe('failed')
    const run = await readRun(app.workspace!, id)
    expect(run.error).toContain('boom: simulated agent failure')
    const events = await readFile(join(app.workspace!, '.huntgry/runs', id, 'events.jsonl'), 'utf8')
    expect(events).toContain('"subtype":"notice"')
    expect(existsSync(join(app.workspace!, FOLDER))).toBe(false)
  })

  test('quitting mid-run and relaunching shows the run as stopped; a reply resumes the same session', async ({ app }) => {
    const fakes = fakeAgents(app)
    await fakes.setScript('slow', { slowMs: 5000 })
    await new Shell(app.window).goTo('tailor')
    let tailor = new TailorPage(app.window)
    await tailor.start(JOB)
    await tailor.expectStatus('Claude is working')
    // The agent has announced its session, read the job (its session file is written) and is in the middle of
    // its first turn: `turn-start` is marked, `turn-end` (5 s of pauses away) is not.
    await expect.poll(async () => (await fakes.runs()).length).toBe(1)
    const [first] = await fakes.runs()
    await expect.poll(async () => (await fakes.turns()).map((t) => [t.pid, t.turn, t.end])).toEqual([[first.pid, 1, null]])
    expect(JSON.parse(await readFile(join(fakes.home, 'sessions', `${first.session}.json`), 'utf8'))).toMatchObject({ role: 'staff-engineer', company: 'acme-corp', jobId: FOLDER.split('/')[2] })
    const [id] = await runIds(app.workspace!)
    await expect.poll(async () => (await readRun(app.workspace!, id)).sessionId).toBe(first.session)

    await app.relaunch()
    // The quit stopped the agent and saved the run as stopped, with its notice.
    expect(await readRun(app.workspace!, id)).toMatchObject({ status: 'stopped', sessionId: first.session })
    await new Shell(app.window).goTo('tailor')
    tailor = new TailorPage(app.window)
    await expect(tailor.runEntry(TITLE)).toContainText('Stopped')
    await tailor.runEntry(TITLE).click()
    await tailor.expectStatus('Stopped')
    await expect(app.window.getByText('Stopped.', { exact: true })).toBeVisible()
    await expect(tailor.replyBox).toHaveAttribute('placeholder', /Continue this conversation \(Claude resumes the session\)/)

    await fakes.setScript('normal')
    await tailor.reply('Go on.')
    await expect(tailor.toolRow('Bash')).toBeVisible({ timeout: 15_000 })
    // The resumed process built for the job it was started with (role, company, job id), not a default folder.
    await expect(tailor.outputLine(FOLDER)).toBeVisible()
    expect(existsSync(join(app.workspace!, FOLDER, 'resume.pdf'))).toBe(true)
    expect(existsSync(join(app.workspace!, 'software-engineer/acme/job'))).toBe(false)
    await expect.poll(async () => (await readRun(app.workspace!, id)).outputFolder).toBe(FOLDER)
    // The second process was told to resume the first one's session, and kept it.
    const runs = await fakes.runs()
    expect(runs).toHaveLength(2)
    expect(runs[1]).toMatchObject({ agent: 'claude', resume: first.session, session: first.session })
    expect(runs[1].args).toContain('--resume')
  })

  test('the agent picked on the form is the one started; without a pick, the Settings default is', async ({ app }) => {
    const fakes = fakeAgents(app)
    await fakes.setScript('normal')
    const shell = new Shell(app.window)
    await shell.goTo('settings')
    await new SettingsPage(app.window).setDefault('Antigravity')

    await shell.goTo('tailor')
    const tailor = new TailorPage(app.window)
    await expect(tailor.agentChoice('Antigravity')).toHaveAccessibleName(/Antigravity \(default\)/)
    await expect(tailor.agentChoice('Antigravity')).toBeChecked()
    await tailor.start({ ...JOB, description: `${JOB.description}\n\nAntigravity team.` })
    await tailor.expectStatus('Finished', 30_000)
    await expect(tailor.runCard.getByText('Antigravity', { exact: true })).toBeVisible()
    await expect(tailor.toolRow('view_file')).toBeVisible()
    await expect.poll(async () => (await fakes.runs()).map((r) => r.agent)).toEqual(['agy'])

    await tailor.newRunButton.click()
    await tailor.pickAgent('Codex')
    const codexJob = { ...JOB, description: `${JOB.description}\n\nCodex team.` }
    await tailor.start(codexJob)
    await tailor.expectStatus('Finished', 30_000)
    await expect(tailor.runCard.getByText('Codex', { exact: true })).toBeVisible()
    await expect.poll(async () => (await fakes.runs()).map((r) => r.agent)).toEqual(['agy', 'codex'])
    const codex = (await fakes.runs())[1]
    expect(codex.args?.slice(0, 2)).toEqual(['exec', '--json'])
    expect(codex.cwd).toBe(app.workspace)
    await expect(tailor.outputLine(pastedFolder(codexJob))).toBeVisible()
    // A follow-up on the finished run: Codex answers in a new process that resumes the thread, and rebuilds.
    await tailor.reply('Make it shorter.')
    await expect(tailor.turnResults).toHaveCount(2, { timeout: 30_000 })
    await tailor.expectStatus('Finished', 30_000)
    const resumed = (await fakes.runs())[2]
    expect(resumed).toMatchObject({ agent: 'codex', resume: codex.session })
    expect(resumed.args?.slice(0, 3)).toEqual(['exec', 'resume', codex.session])
  })
})

test.describe('tailor without any agent', () => {
  test.use({ workspace: 'demo' })

  test('the pre-run check fails with a clear message and Start stays disabled', async ({ app }) => {
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await expect(tailor.formAlert).toContainText('Claude cannot run yet')
    await expect(tailor.formAlert).toContainText('The claude CLI was not found. Use "Install Claude Code" in Settings, then sign in once in a terminal.')
    await expect(tailor.formAlert.getByRole('button', { name: 'Open Settings' })).toBeVisible()
    await tailor.jobDescription.fill(JOB.description)
    await expect(tailor.startButton).toBeDisabled()
    // Every agent is marked as unavailable in the picker.
    for (const agent of ['Claude', 'Codex', 'Antigravity'] as const) {
      await expect(tailor.agentChoice(agent)).toHaveAccessibleName(/not available/)
    }
    await tailor.pickAgent('Codex')
    await expect(tailor.formAlert).toContainText('Codex cannot run yet')
    await expect(tailor.formAlert).toContainText('The codex CLI (Codex) was not found.')
    await expect(tailor.startButton).toBeDisabled()
  })
})
