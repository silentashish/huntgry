import { expect, type Locator, type Page } from '@playwright/test'
import { ProfileEditor, type ProfileViewName } from './profile-editor'
import { Shell } from './shell'

/**
 * The Knowledge graph and Skills views of the Profile page (#95: the graph is a view of the
 * profile, not its own page). The canvas is never asserted: the Skills view is a table, the
 * "Jump to…" select lists every node with its kind, and the node panel is plain markup.
 */
export class GraphPage {
  /** The Profile page's title. */
  readonly heading: Locator
  /** Editor · Knowledge graph · Skills. */
  readonly viewSwitch: Locator
  readonly searchInput: Locator
  /** "Jump to…": a searchable select whose options are `<Kind>: <label>` for every node. */
  readonly nodeSelect: Locator
  /** The "Jobs overlay (N)" chip: its checkbox (state; visually hidden) and its label (what is clicked). */
  readonly jobsOverlay: Locator
  readonly jobsOverlayChip: Locator
  /** The graph's legend: one entry per kind drawn, plus "Gap". */
  readonly legend: Locator
  readonly skillsTable: Locator
  /** All / Gaps / Strong above the Skills table. */
  readonly skillFilter: Locator
  readonly sortSelect: Locator
  readonly emptyState: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Profile', level: 2 })
    this.viewSwitch = page.getByRole('radiogroup', { name: 'Profile view' })
    this.searchInput = page.getByRole('textbox', { name: /^(Highlight|Filter) / })
    this.nodeSelect = page.getByRole('combobox', { name: 'Select a node of the graph' })
    this.jobsOverlay = page.getByRole('checkbox', { name: /^Jobs overlay \(\d+\)$/ })
    this.jobsOverlayChip = page.getByText(/^Jobs overlay \(\d+\)$/)
    this.legend = page.getByRole('list', { name: 'Legend' })
    this.skillsTable = page.getByRole('table')
    this.skillFilter = page.getByRole('radiogroup', { name: 'Show skills' })
    this.sortSelect = page.getByRole('combobox', { name: 'Sort skills' })
    this.emptyState = page.getByRole('heading', { name: 'Nothing to draw yet' })
  }

  /**
   * Opens Profile → Knowledge graph through the Profile page's view switcher, whether or not the
   * sidebar still lists a Knowledge graph entry.
   */
  async open(): Promise<void> {
    await new Shell(this.page).goTo('profile')
    await this.showView('Knowledge graph')
    await this.expectVisible()
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

  view(name: ProfileViewName): Locator {
    return this.viewSwitch.getByRole('radio', { name, exact: true })
  }

  async showView(view: ProfileViewName): Promise<void> {
    await new ProfileEditor(this.page).showView(view)
  }

  /** One row of the Skills table, by skill name. */
  skillRow(skill: string): Locator {
    return this.skillsTable.getByRole('row').filter({ has: this.page.getByRole('button', { name: `Show details for ${skill}`, exact: true }) })
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
    return this.page.getByRole('complementary', { name: new RegExp(`: ${escape(label)}$`) })
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
