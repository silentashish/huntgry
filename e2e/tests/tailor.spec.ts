import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { fakeAgents, withFakeAgents } from '../fixtures/fake-agent'
import { Shell } from '../pages/shell'
import { SettingsPage } from '../pages/settings'
import { openedPaths, stubOpenPath, TailorPage } from '../pages/tailor'

/**
 * A tailoring run from the form to the built files, driven through the app's
 * real runner against the scripted agents (e2e/fixtures/fake-agent): the
 * pre-run check, the streamed transcript, the approval step, the finished
 * files, a failing agent, a quit mid-run, and which agent gets started.
 */

const JOB = {
  description: '# Staff Engineer\n\nAcme Corp is hiring a Staff Engineer for its platform team. Go, PostgreSQL, Kubernetes.',
  company: 'Acme Corp',
  role: 'Staff Engineer',
  jobId: 'A-42'
}
const TITLE = 'Staff Engineer · Acme Corp'
const FOLDER = 'staff-engineer/acme-corp/a-42'

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

  test('a run streams its transcript, waits for the approval, builds the files on "Approved" and finishes', async ({ app }) => {
    await new Shell(app.window).goTo('tailor')
    const tailor = new TailorPage(app.window)
    await tailor.start(JOB)

    // The run opens, its first message is the pasted job, and the agent's text arrives while it is still working.
    await expect(tailor.runTitle(TITLE)).toBeVisible()
    await expect(app.window.getByText('Acme Corp is hiring a Staff Engineer', { exact: false }).first()).toBeVisible()
    await expect(app.window.getByText('Gap analysis for staff-engineer at acme-corp (job a-42)', { exact: false })).toBeVisible()
    await tailor.expectStatus('Claude is working')
    await expect(tailor.turnResults).toHaveCount(0)
    await expect(tailor.toolRow('Read')).toBeVisible()
    // Then the turn ends with the question and the run waits.
    await expect(app.window.getByText('Do you approve these bullets', { exact: false })).toBeVisible()
    await expect(tailor.turnResults).toHaveCount(1)
    await tailor.expectStatus('Waiting for you')
    await expect(tailor.waitingNote).toHaveText('1 run waiting for your reply')
    await expect(tailor.replyBox).toHaveAttribute('placeholder', /^Reply to Claude/)
    await expect(tailor.outputButton('Resume')).toHaveCount(0)

    await tailor.reply('Approved')
    await tailor.expectStatus('Claude is working')
    await expect(tailor.toolRow('Bash')).toBeVisible()
    await tailor.expectStatus('Waiting for you')
    await expect(tailor.turnResults).toHaveCount(2)
    await expect(tailor.outputLine(FOLDER)).toHaveText(`${FOLDER}/ · build-report.json, job-description.md, resume.pdf, resume_data.json`)
    const pdf = join(app.workspace!, FOLDER, 'resume.pdf')
    expect(existsSync(pdf)).toBe(true)
    expect(await readFile(pdf, 'utf8')).toMatch(/^%PDF-1\.4/)
    // No posting URL, so no tracking file; the folder is the skill's alone.
    expect(existsSync(join(app.workspace!, FOLDER, 'huntgry.json'))).toBe(false)

    // "Resume" opens the PDF through the OS (stubbed: the machine's viewer must not open).
    await stubOpenPath(app.electronApp)
    await tailor.outputButton('Resume').click()
    await expect.poll(() => openedPaths(app.electronApp)).toEqual([pdf])

    await tailor.finish()
    await tailor.expectStatus('Finished')
    const [id] = await runIds(app.workspace!)
    await expect.poll(async () => (await readRun(app.workspace!, id)).status).toBe('finished')
    expect(await readRun(app.workspace!, id)).toMatchObject({ outputFolder: FOLDER, outputFiles: ['build-report.json', 'job-description.md', 'resume.pdf', 'resume_data.json'] })

    // The dashboard lists the new application next to the demo ones.
    await new Shell(app.window).goTo('dashboard')
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
    // The agent has announced its session and is in the middle of its first turn.
    await expect.poll(async () => (await fakes.runs()).length).toBe(1)
    const [first] = await fakes.runs()
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
    await tailor.reply('Approved')
    await tailor.expectStatus('Waiting for you')
    await expect(tailor.outputLine(FOLDER)).toBeVisible()
    expect(existsSync(join(app.workspace!, FOLDER, 'resume.pdf'))).toBe(true)
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
    await tailor.start({ ...JOB, jobId: 'agy-1' })
    await tailor.expectStatus('Waiting for you')
    await expect(tailor.runCard.getByText('Antigravity', { exact: true })).toBeVisible()
    await expect(tailor.toolRow('view_file')).toBeVisible()
    await expect.poll(async () => (await fakes.runs()).map((r) => r.agent)).toEqual(['agy'])

    await tailor.newRunButton.click()
    await tailor.pickAgent('Codex')
    await tailor.start({ ...JOB, jobId: 'codex-1' })
    await tailor.expectStatus('Waiting for you')
    await expect(tailor.runCard.getByText('Codex', { exact: true })).toBeVisible()
    await expect.poll(async () => (await fakes.runs()).map((r) => r.agent)).toEqual(['agy', 'codex'])
    const codex = (await fakes.runs())[1]
    expect(codex.args?.slice(0, 2)).toEqual(['exec', '--json'])
    expect(codex.cwd).toBe(app.workspace)
    // Codex answers a reply in a new process that resumes the thread.
    await tailor.reply('Approved')
    await tailor.expectStatus('Waiting for you')
    await expect(tailor.outputLine('staff-engineer/acme-corp/codex-1')).toBeVisible()
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
