import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

/** Status badge texts of a run (src/renderer/src/pages/tailor/status.ts). */
export type RunStatusText = 'Waiting for you' | 'Finished' | 'Failed' | 'Stopped' | `${string} is working`

/**
 * The Tailor page: the start form, the run list, the open run (transcript,
 * reply box, output files) and the bulk queue panel. Role, label and text
 * locators; the open run's card is found by its level-3 title, which only
 * a run view (or the start form) has.
 */
export class TailorPage {
  readonly heading: Locator
  // Start form.
  readonly jobUrl: Locator
  readonly jobDescription: Locator
  readonly company: Locator
  readonly role: Locator
  readonly jobId: Locator
  readonly notes: Locator
  readonly startButton: Locator
  // Run list.
  readonly newRunButton: Locator
  readonly waitingNote: Locator
  // Open run.
  readonly replyBox: Locator
  readonly sendButton: Locator
  readonly endButton: Locator
  readonly errorAlert: Locator
  // Queue panel.
  readonly queuePanel: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Tailor', level: 2 })
    this.jobUrl = page.getByLabel('Job posting URL')
    this.jobDescription = page.getByLabel('Job description')
    this.company = page.getByLabel('Company')
    this.role = page.getByLabel('Role')
    this.jobId = page.getByLabel('Job id')
    this.notes = page.getByLabel(/^Notes for /)
    this.startButton = page.getByRole('button', { name: 'Start tailoring' })
    this.newRunButton = page.getByRole('button', { name: 'New run' })
    this.waitingNote = page.getByText(/^\d+ runs? waiting for your reply$/)
    this.replyBox = page.getByPlaceholder(/Reply to |Continue this conversation|is working; you can reply|cannot be continued/)
    this.sendButton = page.getByRole('button', { name: 'Send' })
    this.endButton = page.getByRole('button', { name: 'End', exact: true })
    this.errorAlert = page.getByRole('alert').filter({ hasText: 'stopped with an error' })
    this.queuePanel = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: 'Tailoring queue' }) })
  }

  /** The "<Agent> cannot run yet" (blocking) or "Some dependencies are missing" alert of the form. */
  get formAlert(): Locator {
    return this.page.getByRole('alert').filter({ hasText: /cannot run yet|dependencies are missing/ })
  }

  /**
   * One choice of the form's agent picker (a Mantine SegmentedControl): the radio
   * input, named "Claude (default)", "Codex", "Antigravity" or "<name>: not available".
   * The input itself is visually hidden; `pickAgent` clicks its label.
   */
  agentChoice(label: 'Claude' | 'Codex' | 'Antigravity'): Locator {
    return this.page.getByRole('radio', { name: new RegExp(`^${label}\\b`) })
  }

  async pickAgent(label: 'Claude' | 'Codex' | 'Antigravity'): Promise<void> {
    await this.agentChoice(label).locator('xpath=following-sibling::label[1]').click()
    await expect(this.agentChoice(label)).toBeChecked()
  }

  /** Fills the form with a pasted description and the folder-naming fields, then starts. */
  async start(job: { description: string; company?: string; role?: string; jobId?: string; jobUrl?: string }): Promise<void> {
    if (job.jobUrl !== undefined) await this.jobUrl.fill(job.jobUrl)
    await this.jobDescription.fill(job.description)
    if (job.company !== undefined) await this.company.fill(job.company)
    if (job.role !== undefined) await this.role.fill(job.role)
    if (job.jobId !== undefined) await this.jobId.fill(job.jobId)
    await expect(this.startButton).toBeEnabled()
    await this.startButton.click()
  }

  /** A run's entry in the list (a button named by the title and its status line). */
  runEntry(title: string): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^${escape(title)}\\b`) })
  }

  /** The header card of the open run (title, agent and status badges, output buttons). */
  get runCard(): Locator {
    return this.page.locator('.mantine-Card-root').filter({ has: this.page.getByRole('heading', { level: 3 }) }).first()
  }

  runTitle(title: string): Locator {
    return this.page.getByRole('heading', { name: title, level: 3 })
  }

  /** The open run's status badge. */
  async expectStatus(status: RunStatusText, timeout = 15_000): Promise<void> {
    await expect(this.runCard.getByText(status, { exact: true })).toBeVisible({ timeout })
  }

  /** The transcript's badge of a tool call (`Read`, `Bash`, `view_file`, …). */
  toolRow(name: string): Locator {
    return this.page.getByText(name, { exact: true })
  }

  /** "Turn finished · $0.01 · 1s" lines, one per ended turn. */
  get turnResults(): Locator {
    return this.page.getByText(/^Turn finished/)
  }

  /** The "<folder>/ · file, file" line under the run's header. */
  outputLine(folder: string): Locator {
    return this.runCard.getByText(new RegExp(`^${escape(folder)}/ · `))
  }

  /** "Resume", "Cover letter", "Show in Finder", "Apply" of the open run (not the queue's Resume). */
  outputButton(name: 'Resume' | 'Cover letter' | 'Show in Finder' | 'Apply'): Locator {
    return this.runCard.getByRole('button', { name, exact: true })
  }

  /** Why the open run's Apply cannot start (or Apply's error), shown under its buttons. */
  get applyReason(): Locator {
    return this.page.getByTestId('apply-reason')
  }

  async reply(text: string): Promise<void> {
    await expect(this.replyBox).toBeEnabled()
    await this.replyBox.fill(text)
    await this.sendButton.click()
  }

  /** End → "Finish conversation". */
  async finish(): Promise<void> {
    await this.endButton.click()
    await this.page.getByRole('menuitem', { name: 'Finish conversation' }).click()
  }

  // Queue panel.

  /** The row of a queued job, found by its "<title> · <company>" label. */
  queueRow(title: string): Locator {
    return this.queuePanel.locator('div').filter({ has: this.page.getByText(title, { exact: true }) }).filter({ has: this.page.getByRole('button', { name: /Cancel|Retry|Remove/ }) }).last()
  }

  get queueResumeButton(): Locator {
    return this.queuePanel.getByRole('button', { name: /^(Resume|Pause)$/ })
  }

  get queuePausedNote(): Locator {
    return this.queuePanel.getByText('Paused: queued jobs start when you press Resume.')
  }

  /** The "N at a time" select (a Mantine Select: an aria-labelled read-only input with an option list). */
  get concurrencySelect(): Locator {
    return this.queuePanel.getByLabel('Runs at once')
  }

  /** The per-job agent select of a job that has not started. */
  queueAgentSelect(title: string): Locator {
    return this.queuePanel.getByLabel(`Agent for ${title}`)
  }

  /** Picks `agent` in a Mantine Select. */
  async pickQueueAgent(title: string, agent: 'Claude' | 'Codex' | 'Antigravity'): Promise<void> {
    await this.queueAgentSelect(title).click()
    await this.page.getByRole('option', { name: agent }).click()
    await expect(this.queueAgentSelect(title)).toHaveValue(agent)
  }

  /** Waits until the queue badge counts read like "2 needs your reply". */
  queueCount(text: string): Locator {
    return this.queuePanel.getByText(text, { exact: true })
  }
}

/**
 * Replaces `shell.openPath` in the main process with a recorder, so "Resume"
 * can be pressed without Preview opening on the machine. `openedPaths` returns
 * what was asked for.
 */
export async function stubOpenPath(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openedPaths: string[] }
    g.__openedPaths = []
    shell.openPath = async (path: string) => {
      g.__openedPaths.push(path)
      return ''
    }
  })
}

export function openedPaths(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => (globalThis as unknown as { __openedPaths?: string[] }).__openedPaths ?? [])
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
