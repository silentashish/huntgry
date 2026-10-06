import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The Jobs page: board search, Refresh (profile-derived search), add by URL, paste, the saved-job list with its
 * segments (Relevant, Last search, All, …), filters and selection, the job drawer and "Tailor all".
 */
export class JobsPage {
  readonly keywords: Locator
  readonly location: Locator
  readonly searchButton: Locator
  readonly remoteOnly: Locator
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
  readonly refreshButton: Locator
  /** "Relevant jobs updated 5 min ago". */
  readonly lastRefreshed: Locator
  /** The sponsorship filter (a Mantine Select: a combobox). */
  readonly sponsorshipFilter: Locator
  /** The auto-refresh toggle (a Mantine Switch: `role="switch"`; its input lies over the label). */
  readonly autoRefresh: Locator
  /** The hint shown instead of the Relevant segment when the profile has no headline or role. */
  readonly relevantHint: Locator

  constructor(readonly page: Page) {
    this.keywords = page.getByLabel('Keywords')
    this.location = page.getByLabel('Location')
    this.searchButton = page.getByRole('button', { name: 'Search', exact: true })
    this.remoteOnly = page.getByLabel('Remote only')
    this.urlInput = page.getByPlaceholder(/^Add a job by its posting URL/)
    this.addButton = page.getByRole('button', { name: 'Add', exact: true })
    this.pasteButton = page.getByRole('button', { name: 'Paste a job' })
    this.filterInput = page.getByPlaceholder(/^Filter saved jobs/)
    this.drawer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Tailor resume' }) })
    this.pasteModal = page.getByRole('dialog', { name: 'Paste a job' })
    this.selectionBar = page.getByLabel('Selected jobs')
    this.tailorAllButton = this.selectionBar.getByRole('button', { name: 'Tailor all' })
    this.refreshButton = page.getByRole('button', { name: 'Refresh', exact: true })
    this.lastRefreshed = page.getByText(/^Relevant jobs updated /)
    this.sponsorshipFilter = page.getByRole('combobox', { name: 'Visa sponsorship' })
    this.autoRefresh = page.getByRole('switch', { name: 'Auto-refresh relevant jobs' })
    this.relevantHint = page.getByRole('alert').filter({ hasText: 'See the jobs that fit you' })
  }

  /**
   * A segment of the saved-job list (a Mantine SegmentedControl: a radio named by its label,
   * e.g. "Relevant (2)", "Last search (4)", "All").
   */
  segment(name: 'Relevant' | 'Last search' | 'Last refresh' | 'All' | 'Not tailored' | 'Tailored' | 'Dismissed'): Locator {
    const counted = name === 'Relevant' || name === 'Last search' || name === 'Last refresh'
    return this.page.getByRole('radio', { name: counted ? new RegExp(`^${name} \\(\\d+\\)$`) : name, exact: !counted })
  }

  /** Shows a segment; the radio input is visually hidden, so its label is clicked. */
  async show(name: Parameters<JobsPage['segment']>[0]): Promise<void> {
    await this.segment(name).locator('xpath=following-sibling::label[1]').click()
    await expect(this.segment(name)).toBeChecked()
  }

  /** Flips auto-refresh. Mantine's switch input covers its label and takes the click itself. */
  async toggleAutoRefresh(on: boolean): Promise<void> {
    await this.autoRefresh.click()
    await expect(this.autoRefresh).toBeChecked({ checked: on })
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

  /** A board chip (Mantine Chip: a checkbox named by its label). */
  board(name: 'hiring.cafe' | 'Indeed'): Locator {
    return this.page.getByRole('checkbox', { name, exact: true })
  }

  /** The per-board result notice after a search, e.g. "hiring.cafe: 2 jobs". */
  report(title: RegExp | string): Locator {
    return this.page.getByRole('alert').filter({ hasText: title })
  }

  /** Any red error notice (add by URL, search, queue). */
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

  async search(keywords: string): Promise<void> {
    await this.keywords.fill(keywords)
    await this.searchButton.click()
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
