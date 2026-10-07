import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

export type AgentLabel = 'Claude' | 'Codex' | 'Antigravity'

/**
 * The Settings page: the banner, the Agents card (one row per agent with the
 * default-agent radio, CLI path + version, skill path or "Install skill"), the
 * Claude card (CLI, account, skill, venv, LaTeX rows with their buttons) and
 * the skill's preflight table. Role, label and text locators only.
 */
export class SettingsPage {
  readonly heading: Locator
  readonly checkAgainButton: Locator
  readonly readyBanner: Locator
  readonly notReadyBanner: Locator
  readonly warnings: Locator
  readonly agentsTable: Locator
  readonly installClaudeButton: Locator
  readonly updateClaudeButton: Locator
  readonly installSkillButton: Locator
  readonly installPythonButton: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Settings', level: 2 })
    this.checkAgainButton = page.getByRole('button', { name: 'Check again' })
    this.readyBanner = page.getByRole('alert').filter({ hasText: 'Ready to tailor' })
    this.notReadyBanner = page.getByRole('alert').filter({ hasText: 'Not everything is in place' })
    this.warnings = page.getByRole('alert').filter({ hasText: /older than|could not be read/ })
    this.agentsTable = page.getByRole('table').filter({ hasText: 'Antigravity' })
    this.installClaudeButton = page.getByRole('button', { name: 'Install Claude Code' })
    this.updateClaudeButton = page.getByRole('button', { name: 'Update Claude Code' })
    this.installSkillButton = page.getByRole('button', { name: 'Install resume-tailor skill' })
    this.installPythonButton = page.getByRole('button', { name: /Install Python dependencies|Reinstall Python dependencies/ })
  }

  /** The radio that makes `agent` the default. */
  defaultRadio(agent: AgentLabel): Locator {
    return this.page.getByRole('radio', { name: `Make ${agent} the default agent` })
  }

  /** The row of `agent` in the Agents card. */
  agentRow(agent: AgentLabel): Locator {
    return this.agentsTable.getByRole('row').filter({ has: this.defaultRadio(agent) })
  }

  /** "Install skill" of a non-Claude agent that cannot see the skill yet. */
  linkSkillButton(agent: Exclude<AgentLabel, 'Claude'>): Locator {
    return this.agentRow(agent).getByRole('button', { name: 'Install skill' })
  }

  /** The picker of `agent`'s CLI, shown when several copies are found (#79). */
  cliSelect(agent: AgentLabel): Locator {
    return this.page.getByRole('combobox', { name: `${agent} CLI to use` })
  }

  /** Picks the copy at `path` of `agent`'s CLI. */
  async chooseCli(agent: AgentLabel, path: string): Promise<void> {
    await this.cliSelect(agent).click()
    await this.page.getByRole('option', { name: path, exact: true }).click()
  }

  /** "Remove": back to the first copy found. Only shown once a copy was chosen. */
  removeCliButton(agent: AgentLabel): Locator {
    return this.page.getByRole('button', { name: `Remove the chosen ${agent} CLI` })
  }

  /** Rows of the Claude card by their header cell. */
  row(label: 'Claude CLI' | 'Account' | 'resume-tailor skill' | 'Python venv' | 'LaTeX'): Locator {
    return this.page.getByRole('row', { name: new RegExp(`^${label}\\b`) })
  }

  /** The preflight table row of one dependency. */
  preflightRow(name: string): Locator {
    return this.page.getByRole('row').filter({ has: this.page.getByRole('cell', { name, exact: true }) })
  }

  /** The change goes through IPC before the radio re-renders as checked, so click and wait rather than `check()`. */
  async setDefault(agent: AgentLabel): Promise<void> {
    await this.defaultRadio(agent).click()
    await expect(this.defaultRadio(agent)).toBeChecked()
  }

  /** The agent row reads: CLI found at `cliPath` with `version`, ready, skill at `skillPath`. */
  async expectAgentReady(agent: AgentLabel, cliPath: string, version: string, skillPath: string): Promise<void> {
    const row = this.agentRow(agent)
    await expect(row.getByText(cliPath, { exact: true })).toBeVisible()
    await expect(row.getByText(version, { exact: true })).toBeVisible()
    await expect(row.getByText('Ready', { exact: true })).toBeVisible()
    await expect(row.getByText(skillPath, { exact: true })).toBeVisible()
  }

  /** The agent row reads: not found, with its install hint, no skill. */
  async expectAgentMissing(agent: AgentLabel, hint: RegExp): Promise<void> {
    const row = this.agentRow(agent)
    await expect(row.getByText('Not found', { exact: true })).toBeVisible()
    await expect(row.getByText('Not ready', { exact: true })).toBeVisible()
    await expect(row.getByText('Not installed', { exact: true })).toBeVisible()
    await expect(row.getByText(hint)).toBeVisible()
  }
}

/** The main process's PATH and the pinned Claude binary, as the app sees them. */
export function mainEnv(electronApp: ElectronApplication): Promise<{ PATH: string | undefined; HUNTGRY_CLAUDE_PATH: string | undefined; HOME: string | undefined }> {
  return electronApp.evaluate(() => ({
    PATH: process.env.PATH,
    HUNTGRY_CLAUDE_PATH: process.env.HUNTGRY_CLAUDE_PATH,
    HOME: process.env.HOME
  }))
}
