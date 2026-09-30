import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeApp, createSandbox, destroySandbox, expect, launchApp, test } from '../fixtures/app'
import { Shell } from '../pages/shell'

/**
 * The harness's own guarantees: the app under test sees nothing of the
 * machine it runs on, and leaves nothing behind. Every later spec relies on this.
 */

const REPO = resolve(__dirname, '../..')
const REAL_HOME = homedir()
/** What a real run of the app would touch: its userData and the Claude Code folder. */
const PROTECTED = [join(REAL_HOME, 'Library/Application Support/Huntgry'), join(REAL_HOME, '.claude')]

const mtimes = () => Promise.all(PROTECTED.map((p) => stat(p).then((s) => s.mtimeMs, () => null)))
const gitStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })

test.describe('isolation', () => {
  test.use({ workspace: 'demo' })

  test('the app runs with the sandbox HOME, userData and PATH, and nothing from the runner', async ({ app }) => {
    const before = await mtimes()
    const status = gitStatus()

    // What the main process sees: `userData` (the only app path src/main uses) and its environment.
    // Every `~/…` lookup in src/main goes through `os.homedir()`, which follows HOME; Electron's own
    // `app.getPath('home')` comes from the user database on macOS instead, and nothing reads it.
    const seen = await app.electronApp.evaluate(({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      packaged: electronApp.isPackaged,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        HUNTGRY_E2E: process.env.HUNTGRY_E2E,
        HUNTGRY_ALLOW_LOCAL_URLS: process.env.HUNTGRY_ALLOW_LOCAL_URLS,
        ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL,
        CLAUDECODE: process.env.CLAUDECODE,
        HUNTGRY_CLAUDE_PATH: process.env.HUNTGRY_CLAUDE_PATH
      }
    }))
    expect(seen.env.HOME).toBe(app.home)
    expect(seen.userData).toBe(app.userData)
    expect(seen.packaged).toBe(false)
    expect(seen.env.HUNTGRY_E2E).toBe('1')
    expect(seen.env.HUNTGRY_ALLOW_LOCAL_URLS).toBe('1')
    expect(seen.env.ELECTRON_RENDERER_URL).toBeUndefined()
    expect(seen.env.CLAUDECODE).toBeUndefined()
    expect(seen.env.HUNTGRY_CLAUDE_PATH).toBeUndefined()
    const path = seen.env.PATH!.split(':')
    expect(path[0]).toBe(app.sandbox.bin)
    expect(path).toEqual([app.sandbox.bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(seen.env.PATH).not.toContain(REAL_HOME)

    // The skill lookup (`~/.claude/skills`) goes through the sandbox HOME: a skill planted there is found,
    // so whatever the real ~/.claude holds is never what Settings shows.
    const skill = join(app.home, '.claude/skills/resume-tailor')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: resume-tailor\n---\n')
    await new Shell(app.window).goTo('settings')
    await expect(app.window.getByText(skill, { exact: true }).first()).toBeVisible()
    await expect(app.window.getByText('Not found', { exact: true }).first()).toBeVisible()

    // Then check the machine is untouched: the real userData and ~/.claude, and the repo.
    expect(await mtimes()).toEqual(before)
    expect(gitStatus()).toBe(status)
    expect(existsSync(join(app.userData, 'settings.json'))).toBe(true) // the remembered workspace lives in the sandbox
  })

  test('the real claude, codex and agy are not found; a fake in the sandbox bin is', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.goTo('settings')
    const agents = app.window.getByRole('table').filter({ hasText: 'Antigravity' })
    await expect(agents).toBeVisible()
    for (const agent of ['Claude', 'Codex', 'Antigravity']) {
      const row = agents.getByRole('row').filter({ has: app.window.getByRole('radio', { name: `Make ${agent} the default agent` }) })
      await expect(row.getByText('Not found', { exact: true })).toBeVisible()
      await expect(row.getByText('Not installed', { exact: true })).toBeVisible()
    }
    // The Claude Code table below the agents says the same for the CLI.
    await expect(app.window.getByRole('row', { name: /^Claude CLI/ }).getByText('Not found', { exact: true })).toBeVisible()

    // Discovery still works through the sandbox PATH, which is how later tickets plug in fake agents.
    const fake = join(app.sandbox.bin, 'claude')
    await writeFile(
      fake,
      '#!/bin/sh\ncase "$1" in\n  --version) echo "9.9.9 (Claude Code)" ;;\n  auth) echo "{\\"loggedIn\\":false}" ;;\nesac\n'
    )
    await chmod(fake, 0o755)
    await app.window.getByRole('button', { name: 'Check again' }).click()
    await expect(app.window.getByText(fake, { exact: true }).first()).toBeVisible()
    await expect(app.window.getByText('9.9.9', { exact: true }).first()).toBeVisible()
  })
})

test('closing the app removes its sandbox (userData, HOME, workspaces)', async () => {
  const sandbox = await createSandbox()
  const launched = await launchApp(sandbox)
  await expect(launched.window.getByRole('button', { name: 'Create New Workspace' })).toBeVisible()
  expect(existsSync(sandbox.userData)).toBe(true)
  await closeApp(launched.electronApp)
  await destroySandbox(sandbox)
  expect(existsSync(sandbox.root)).toBe(false)
})
