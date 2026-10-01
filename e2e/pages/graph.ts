import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The Knowledge graph page. The canvas is never asserted: the Skills view is a
 * table, the "Jump to…" select lists every node with its kind, and the node
 * panel is plain markup.
 */
export class GraphPage {
  readonly heading: Locator
  readonly viewSwitch: Locator
  readonly searchInput: Locator
  /** "Jump to…": a searchable select whose options are `<Kind>: <label>` for every node. */
  readonly nodeSelect: Locator
  /** The "Jobs overlay (N)" chip: its checkbox (state; visually hidden) and its label (what is clicked). */
  readonly jobsOverlay: Locator
  readonly jobsOverlayChip: Locator
  readonly skillsTable: Locator
  readonly emptyState: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Knowledge graph', level: 2 })
    this.viewSwitch = page.getByRole('radiogroup')
    this.searchInput = page.getByRole('textbox', { name: /^(Highlight|Filter) / })
    this.nodeSelect = page.getByRole('combobox', { name: 'Select a node of the graph' })
    this.jobsOverlay = page.getByRole('checkbox', { name: /^Jobs overlay \(\d+\)$/ })
    this.jobsOverlayChip = page.getByText(/^Jobs overlay \(\d+\)$/)
    this.skillsTable = page.getByRole('table')
    this.emptyState = page.getByRole('heading', { name: 'Nothing to draw yet' })
  }

  async expectVisible(): Promise<void> {
    await expect(this.heading).toBeVisible()
    await expect(this.jobsOverlayChip).toBeVisible()
  }

  async toggleJobsOverlay(on: boolean): Promise<void> {
    if ((await this.jobsOverlay.isChecked()) !== on) await this.jobsOverlayChip.click()
    if (on) await expect(this.jobsOverlay).toBeChecked()
    else await expect(this.jobsOverlay).not.toBeChecked()
  }

  async showView(view: 'Graph' | 'Skills'): Promise<void> {
    await this.viewSwitch.getByText(view, { exact: true }).click()
    await expect(this.viewSwitch.getByRole('radio', { name: view })).toBeChecked()
  }

  /** One row of the Skills table, by skill name. */
  skillRow(skill: string): Locator {
    return this.skillsTable.getByRole('row').filter({ has: this.page.getByRole('button', { name: `Show details for ${skill}` }) })
  }

  /** Every node listed by "Jump to…" as `<Kind>: <label>`, then closes the list. */
  async nodeLabels(): Promise<string[]> {
    await this.nodeSelect.click()
    const options = this.page.getByRole('option')
    await expect(options.first()).toBeVisible()
    const labels = await options.allTextContents()
    await this.page.keyboard.press('Escape')
    return labels
  }

  /** The details card of the selected node (its title is a level-4 heading). */
  nodePanel(label: string): Locator {
    return this.page.getByRole('heading', { name: label, level: 4 }).locator('xpath=ancestor::*[.//button][1]')
  }
}
