import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The Jobs page: add by URL, paste, the saved-job list with its segments (Relevant, All, …), filters and
 * selection, the job drawer and "Tailor all".
 */
export class JobsPage {
  readonly urlInput: Locator
  readonly addButton: Locator
  readonly pasteButton: Locator
  readonly filterInput: Locator
  /** The job drawer (a Mantine Drawer: `role="dialog"`). */
  readonly drawer: Locator
  readonly pasteModal: Locator
  /** The bar that appears once a job is ticked. */
  readonly selectionBar: Locator
  readonly tailorAllButton: Locator
  /** The sponsorship filter (a Mantine Select: a combobox). */
  readonly sponsorshipFilter: Locator
  /** The hint shown instead of the Relevant segment when the profile has no headline or role. */
  readonly relevantHint: Locator

  constructor(readonly page: Page) {
    this.urlInput = page.getByPlaceholder(/^Add a job by its posting URL/)
    this.addButton = page.getByRole('button', { name: 'Add', exact: true })
    this.pasteButton = page.getByRole('button', { name: 'Paste a job' })
    this.filterInput = page.getByPlaceholder(/^Filter saved jobs/)
    this.drawer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Tailor resume' }) })
    this.pasteModal = page.getByRole('dialog', { name: 'Paste a job' })
    this.selectionBar = page.getByLabel('Selected jobs')
    this.tailorAllButton = this.selectionBar.getByRole('button', { name: 'Tailor all' })
    this.sponsorshipFilter = page.getByRole('combobox', { name: 'Visa sponsorship' })
    this.relevantHint = page.getByRole('alert').filter({ hasText: 'See the jobs that fit you' })
  }

  /**
   * A segment of the saved-job list (a Mantine SegmentedControl: a radio named by its label,
   * e.g. "Relevant (2)", "All").
   */
  segment(name: 'Relevant' | 'All' | 'Not tailored' | 'Tailored' | 'Dismissed'): Locator {
    const counted = name === 'Relevant'
    return this.page.getByRole('radio', { name: counted ? new RegExp(`^${name} \\(\\d+\\)$`) : name, exact: !counted })
  }

  /** Shows a segment; the radio input is visually hidden, so its label is clicked. */
  async show(name: Parameters<JobsPage['segment']>[0]): Promise<void> {
    await this.segment(name).locator('xpath=following-sibling::label[1]').click()
    await expect(this.segment(name)).toBeChecked()
  }

  /** Picks a sponsorship filter option. */
  async filterSponsorship(option: 'Any' | 'Hide "no sponsorship"' | 'Only sponsors'): Promise<void> {
    await this.sponsorshipFilter.click()
    await this.page.getByRole('option', { name: option, exact: true }).click()
    await expect(this.sponsorshipFilter).toHaveValue(option)
  }

  /** Titles of the listed job cards, top to bottom. */
  async listedTitles(): Promise<string[]> {
    return this.page.getByRole('checkbox', { name: /^Select / }).evaluateAll((boxes) =>
      // Only the cards' boxes carry an aria-label; "Select all shown (n)" is named by its <label>.
      boxes.map((b) => (b.getAttribute('aria-label') ?? '').replace(/^Select /, '')).filter(Boolean)
    )
  }

  /** Any red error notice (add by URL, queue). */
  get error(): Locator {
    return this.page.getByRole('alert')
  }

  /** The title line of a saved-job card. */
  jobTitle(title: string): Locator {
    return this.page.getByText(title, { exact: true })
  }

  /** The selection checkbox of a saved-job card. */
  select(title: string): Locator {
    return this.page.getByRole('checkbox', { name: `Select ${title}` })
  }

  /** Opens the drawer of a listed job. */
  async openJob(title: string): Promise<void> {
    await this.jobTitle(title).first().click()
    await expect(this.drawer).toBeVisible()
    await expect(this.drawer.getByText(title, { exact: true }).first()).toBeVisible()
  }

  drawerButton(name: 'Tailor resume' | 'Open posting' | 'Fetch full description' | 'Dismiss' | 'Restore'): Locator {
    return this.drawer.getByRole('button', { name, exact: true })
  }

  /** Escape closes the drawer (its close button has no accessible name of its own). */
  async closeDrawer(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.drawer).toBeHidden()
  }

  async addByUrl(url: string): Promise<void> {
    await this.urlInput.fill(url)
    await this.addButton.click()
  }
}
