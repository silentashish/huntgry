import { lstat, mkdir, readFile, readlink, chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Preparer } from '../fixtures/app'
import { fakeAgents, fakeSkillDir, installFakeAgents, withFakeAgents } from '../fixtures/fake-agent'
import { mainEnv, SettingsPage } from '../pages/settings'
import { Shell } from '../pages/shell'

/**
 * Settings against the scripted agents and against nothing: what each agent
 * row and the Claude card say in both states, the default agent, "Install
 * skill" for Codex and Antigravity, and the install/update buttons, which are
 * only ever looked at. No real installer, no network: the app's PATH is the
 * sandbox one and the shims never reach the network.
 */

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

async function openSettings(app: { window: import('@playwright/test').Page }): Promise<SettingsPage> {
  await new Shell(app.window).goTo('settings')
  return new SettingsPage(app.window)
}

test.describe('with every agent faked', () => {
  test.use({ workspace: 'demo', prepare: withFakeAgents() })

  test('every agent is found with its version, Claude is signed in, and each sees the skill', async ({ app }) => {
    const fakes = fakeAgents(app)
    const settings = await openSettings(app)
    await expect(settings.readyBanner).toContainText('Claude (the default agent), the resume-tailor skill and every dependency it needs to build PDFs are installed.')
    await expect(settings.notReadyBanner).toHaveCount(0)
    await settings.expectAgentReady('Claude', fakes.bin('claude'), '9.9.9', fakeSkillDir(app.sandbox, 'claude'))
    await settings.expectAgentReady('Codex', fakes.bin('codex'), '0.99.0', fakeSkillDir(app.sandbox, 'codex'))
    await settings.expectAgentReady('Antigravity', fakes.bin('agy'), '1.99.0', fakeSkillDir(app.sandbox, 'agy'))
    await expect(settings.defaultRadio('Claude')).toBeChecked()

    await expect(settings.row('Claude CLI')).toContainText(fakes.bin('claude'))
    await expect(settings.row('Claude CLI').getByText('9.9.9', { exact: true })).toBeVisible()
    await expect(settings.row('Account')).toContainText('Signed in as fake@example.com')
    await expect(settings.row('Account').getByText('max', { exact: true })).toBeVisible()
    await expect(settings.row('resume-tailor skill')).toContainText(fakeSkillDir(app.sandbox))
    await expect(settings.row('LaTeX')).toContainText(join(app.home, 'Library/TinyTeX/bin/universal-darwin'))
    await expect(settings.preflightRow('pdflatex').getByText('OK', { exact: true })).toBeVisible()
    await expect(settings.installClaudeButton).toHaveCount(0)
    await expect(settings.updateClaudeButton).toHaveCount(0)
    await expect(settings.installSkillButton).toHaveCount(0)
    await expect(settings.warnings).toHaveCount(0)

    // The check ran `--version` on all three shims and `auth status` on Claude; never a run.
    const calls = await fakes.invocations()
    expect(calls.filter((c) => c.mode === 'run')).toEqual([])
    expect(new Set(calls.filter((c) => c.mode === 'version').map((c) => c.agent))).toEqual(new Set(['claude', 'codex', 'agy']))
    expect(calls.some((c) => c.mode === 'auth' && c.agent === 'claude')).toBe(true)

    // PATH isolation: the app's PATH is the sandbox bin plus the system folders, and Claude is pinned to the shim.
    const env = await mainEnv(app.electronApp)
    expect(env.PATH?.split(':')).toEqual([app.sandbox.bin, ...SYSTEM_PATH])
    expect(env.HUNTGRY_CLAUDE_PATH).toBe(fakes.bin('claude'))
    expect(env.HOME).toBe(app.home)
  })

  test('the default agent switch persists across a relaunch', async ({ app }) => {
    let settings = await openSettings(app)
    await settings.setDefault('Codex')
    await expect(settings.readyBanner).toContainText('Codex (the default agent)')
    await expect.poll(async () => JSON.parse(await readFile(join(app.userData, 'settings.json'), 'utf8')).defaultAgent).toBe('codex')

    await app.relaunch()
    settings = await openSettings(app)
    await expect(settings.defaultRadio('Codex')).toBeChecked()
    await expect(settings.defaultRadio('Claude')).not.toBeChecked()
    await expect(settings.readyBanner).toContainText('Codex (the default agent)')
  })
})

test.describe('with an old Claude Code', () => {
  test.use({ workspace: 'demo', prepare: withFakeAgents({ claudeVersion: '2.0.0' }) })

  test('the warning names both versions and the Update button is enabled (never pressed)', async ({ app }) => {
    const fakes = fakeAgents(app)
    const settings = await openSettings(app)
    await expect(settings.warnings).toContainText('Claude Code 2.0.0 is older than 2.1.259. Runs work, but update it (Update Claude Code).')
    await expect(settings.row('Claude CLI').getByText('2.0.0', { exact: true })).toBeVisible()
    await expect(settings.updateClaudeButton).toBeEnabled()
    await expect(settings.installClaudeButton).toHaveCount(0)
    // Still ready: an old version does not block runs.
    await expect(settings.readyBanner).toBeVisible()
    expect((await fakes.invocations()).filter((c) => c.mode === 'run')).toEqual([])
  })
})

test.describe('with a decoy claude below HOME', () => {
  const decoy: Preparer = {
    async prepare({ sandbox }) {
      // `~/.local/bin` is looked up before PATH; only the pin keeps the shim in front of it.
      const dir = join(sandbox.home, '.local/bin')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'claude'), '#!/bin/sh\necho "1.0.0 (Claude Code)"\n')
      await chmod(join(dir, 'claude'), 0o755)
      return installFakeAgents(sandbox)
    }
  }
  test.use({ workspace: 'demo', prepare: decoy })

  test('the pinned shim is the Claude the app uses, not the decoy', async ({ app }) => {
    const fakes = fakeAgents(app)
    const settings = await openSettings(app)
    await expect(settings.row('Claude CLI')).toContainText(fakes.bin('claude'))
    await expect(settings.row('Claude CLI').getByText('9.9.9', { exact: true })).toBeVisible()
    await expect(app.window.getByText(join(app.home, '.local/bin/claude'), { exact: true })).toHaveCount(0)
  })
})

test.describe('with nothing installed', () => {
  test.use({ workspace: 'demo' })

  test('every agent is Not found with its install hint; the install buttons are enabled and only described', async ({ app }) => {
    const settings = await openSettings(app)
    await expect(settings.readyBanner).toHaveCount(0)
    await expect(settings.notReadyBanner).toContainText('The claude CLI was not found. Use "Install Claude Code" in Settings, then sign in once in a terminal.')
    await expect(settings.notReadyBanner).toContainText('The resume-tailor skill is not installed. Use "Install resume-tailor skill" in Settings.')
    await expect(settings.notReadyBanner).toContainText('No LaTeX (pdflatex) found.')
    await settings.expectAgentMissing('Claude', /Use "Install Claude Code" in Settings, then sign in once in a terminal\./)
    await settings.expectAgentMissing('Codex', /Install it with "brew install --cask codex" or "npm install -g @openai\/codex", then run "codex login" once\./)
    await settings.expectAgentMissing('Antigravity', /Install the Antigravity CLI \(antigravity\.google\/docs\/cli\), then run "agy" once to sign in\./)
    // The other agents cannot link a skill Claude does not have.
    await expect(settings.agentRow('Codex')).toContainText('Install the resume-tailor skill for Claude first (below).')
    await expect(settings.linkSkillButton('Codex')).toHaveCount(0)

    await expect(settings.row('Claude CLI').getByText('Not found', { exact: true })).toBeVisible()
    await expect(settings.installClaudeButton).toBeEnabled()
    await expect(settings.row('Claude CLI')).toContainText('Runs the official installer. Or in a terminal: curl -fsSL https://claude.ai/install.sh | bash')
    await expect(settings.row('Account')).toHaveCount(0)
    await expect(settings.row('resume-tailor skill').getByText('Not found', { exact: true })).toBeVisible()
    await expect(settings.installSkillButton).toBeEnabled()
    await expect(settings.installPythonButton).toBeDisabled()
    await expect(app.window.getByText('The preflight check did not run (skill not found).')).toBeVisible()

    const env = await mainEnv(app.electronApp)
    expect(env.PATH?.split(':')).toEqual([app.sandbox.bin, ...SYSTEM_PATH])
    expect(env.HUNTGRY_CLAUDE_PATH).toBeUndefined()
  })
})

test.describe('with the skill installed for Claude only', () => {
  test.use({ workspace: 'demo', prepare: withFakeAgents({ skills: 'claude' }) })

  test('"Install skill" links the Claude copy into the Codex and Antigravity folders and the rows update', async ({ app }) => {
    const settings = await openSettings(app)
    const source = fakeSkillDir(app.sandbox, 'claude')
    await expect(settings.notReadyBanner).toHaveCount(0)
    for (const [agent, name] of [
      ['Codex', 'codex'],
      ['Antigravity', 'agy']
    ] as const) {
      const target = fakeSkillDir(app.sandbox, name)
      const row = settings.agentRow(agent)
      await expect(row.getByText('Not installed', { exact: true })).toBeVisible()
      await expect(row.getByText('Not ready', { exact: true })).toBeVisible()
      await expect(row).toContainText(`Links it at ${target}`)
      await settings.linkSkillButton(agent).click()
      await expect(row.getByText(target, { exact: true })).toBeVisible()
      await expect(row.getByText('Ready', { exact: true })).toBeVisible()
      await expect(settings.linkSkillButton(agent)).toHaveCount(0)
      // A symlink to the Claude copy, inside the sandbox HOME.
      expect((await lstat(target)).isSymbolicLink()).toBe(true)
      expect(await readlink(target)).toBe(source)
      expect(target.startsWith(app.home)).toBe(true)
    }
  })
})
