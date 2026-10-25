import { expect, type Locator, type Page } from '@playwright/test'
import { Shell } from './shell'

/**
 * The Automation page (#154): the run's status pill and controls, the jobs Ready to submit (one
 * `<article aria-label="Ready to submit: <title> · <company>">` each), the jobs that need you
 * (`<li aria-label="Needs you: <title> · <company>">`), the Candidates table and the Step log.
 * Addressed by roles and labels only.
 */
export class AutomationPage {
  readonly heading: Locator
  /** The header pill: "Automation status: Off", "…: Running · Tailoring", "…: Paused", … */
  readonly status: Locator
  readonly runNowButton: Locator
  readonly pauseButton: Locator
  readonly resumeButton: Locator
  readonly stopButton: Locator
  readonly windowSwitch: Locator
  readonly readySection: Locator
  readonly needsYouSection: Locator
  readonly candidates: Locator
  readonly log: Locator
  readonly logFilter: Locator
  readonly saveSettingsButton: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Automation', level: 2 })
    this.status = page.getByRole('status', { name: /^Automation status:/ })
    this.runNowButton = page.getByRole('button', { name: 'Run now' })
    this.pauseButton = page.getByRole('button', { name: 'Pause', exact: true })
    this.resumeButton = page.getByRole('button', { name: 'Resume', exact: true })
    this.stopButton = page.getByRole('button', { name: 'Stop', exact: true })
    this.windowSwitch = page.getByRole('switch', { name: 'Run window' })
    this.readySection = page.getByRole('region', { name: 'Ready to submit' })
    this.needsYouSection = page.getByRole('region', { name: 'Needs you' })
    this.candidates = page.getByRole('table', { name: 'Candidates' })
    this.log = page.getByRole('list', { name: 'Step log entries' })
    this.logFilter = page.getByRole('textbox', { name: 'Filter the log by job' })
    this.saveSettingsButton = page.getByRole('button', { name: 'Save settings' })
  }

  /** Opens the page from the sidebar. */
  async goto(): Promise<void> {
    await new Shell(this.page).goTo('automation')
    await expect(this.heading).toBeVisible()
  }

  async runNow(): Promise<void> {
    await this.runNowButton.click()
  }

  async expectStatus(text: string | RegExp): Promise<void> {
    await expect(this.status).toHaveAccessibleName(typeof text === 'string' ? `Automation status: ${text}` : text)
  }

  /** A row of the Candidates table, by text in it (company or title). */
  row(name: string | RegExp): Locator {
    return this.candidates.getByRole('row', { name })
  }

  /** The row shows `label` (a step: "Tailoring", "Skipped", …) as its step. */
  async expectStep(name: string | RegExp, label: string, timeout?: number): Promise<void> {
    await expect(this.row(name).getByRole('cell').nth(5)).toContainText(label, timeout ? { timeout } : undefined)
  }

  /** The row's first reason (a skip or cap reason, the match). */
  reason(name: string | RegExp): Locator {
    return this.row(name).getByRole('cell').nth(4)
  }

  /** A Ready to submit card, by its job title (or "title · company"). */
  readyCard(name: string): Locator {
    return this.page.getByRole('article', { name: new RegExp(`^Ready to submit: ${escape(name)}`) })
  }

  /** "Review & submit" on a Ready card: approves the result and opens the filled form in Browser. */
  async reviewAndSubmit(name: string): Promise<void> {
    await this.readyCard(name).getByRole('button', { name: 'Review & submit' }).click()
  }

  /** A Needs you row, by its job title (or "title · company"). */
  needsYou(name: string): Locator {
    return this.page.getByRole('listitem', { name: new RegExp(`^Needs you: ${escape(name)}`) })
  }

  async retry(name: string): Promise<void> {
    await this.needsYou(name).getByRole('button', { name: 'Retry step' }).click()
  }

  /** The step log's lines, newest first. */
  logEntries(): Locator {
    return this.log.getByRole('listitem')
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
