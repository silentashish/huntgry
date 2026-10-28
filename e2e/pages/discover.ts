import { expect, type Locator, type Page } from '@playwright/test'
import { Shell } from './shell'

/**
 * Jobs → Discover (#189; the Explore page of #142, #169): Jobright's list of one category, its posted-day buttons
 * (older days under "Earlier"), filters, the source it shows, per-row Save / "Saved ✓", and each row's match score
 * (#150) with its sort and "Match ≥ N" filter.
 */
export class DiscoverTab {
  readonly heading: Locator
  /** The Jobs page's tab switch (a Mantine SegmentedControl: radios named "Discover" and "Saved (n)"). */
  readonly tab: Locator
  readonly refreshButton: Locator
  readonly filterInput: Locator
  readonly days: Locator
  readonly list: Locator
  readonly error: Locator
  /** Shown while Jobright is not connected (#146), with a "Connect Jobright" button to Settings. */
  readonly connectHint: Locator
  /** The category picker (#169), a Mantine Select. */
  readonly category: Locator
  /** "newgrad-jobs API · 12 jobs" or "Jobright's GitHub list (fallback) · 6 jobs". */
  readonly source: Locator
  /** The warning shown when the list is the README fallback, with the API's error. */
  readonly fallback: Locator
  /** The toggle of the days past the newest seven. */
  readonly earlier: Locator
  readonly h1bFilter: Locator
  readonly minSalary: Locator
  /** "Match ≥ N" (#150). */
  readonly minMatch: Locator
  /** Newest first / Best match (#150), a Mantine Select. */
  readonly sort: Locator
  /** The open tooltip of a match badge. */
  readonly tooltip: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Jobs', level: 2 })
    this.tab = page.getByRole('radiogroup', { name: 'Jobs view' }).getByRole('radio', { name: 'Discover', exact: true })
    this.refreshButton = page.getByRole('button', { name: 'Refresh', exact: true }).first()
    this.filterInput = page.getByRole('textbox', { name: 'Filter Jobright jobs' })
    this.days = page.getByRole('group', { name: 'Posted day' })
    this.list = page.getByRole('list', { name: 'Jobright jobs' })
    this.error = page.getByRole('alert').filter({ hasText: 'The Jobright list could not be loaded' })
    this.connectHint = page.getByRole('alert').filter({ hasText: "Get the employer's own posting links" })
    this.category = page.getByRole('combobox', { name: 'Category' })
    this.source = page.getByLabel('List source')
    this.fallback = page.getByRole('alert').filter({ hasText: "Showing Jobright's GitHub list instead" })
    this.earlier = this.days.getByRole('button', { name: /^Earlier, / })
    this.h1bFilter = page.getByRole('combobox', { name: 'Visa sponsorship' })
    this.minSalary = page.getByRole('textbox', { name: 'Min. salary / year' })
    this.minMatch = page.getByRole('textbox', { name: 'Min. match' })
    this.sort = page.getByRole('combobox', { name: 'Sort' })
    this.tooltip = page.getByRole('tooltip')
  }

  /** Opens Jobs from the sidebar and its Discover tab (the page may open on Saved). */
  async open(): Promise<void> {
    await new Shell(this.page).goTo('jobs')
    await this.tab.locator('xpath=following-sibling::label[1]').click()
    await expect(this.tab).toBeChecked()
    await expect(this.days.or(this.page.getByRole('heading', { name: 'No jobs to discover yet' }))).toBeVisible()
  }

  /** Picks a category by its label ("Data Analysis"; the first one with that label is New grad · US). */
  async pickCategory(label: string): Promise<void> {
    await this.category.click()
    await this.page.getByRole('option', { name: label, exact: true }).first().click()
    await expect(this.category).toHaveValue(label)
  }

  /** The visa select, in the Saved tab's words (#189) over Jobright's H1B field. */
  async filterH1b(option: 'Visa: any' | 'Visa: only sponsors' | 'Visa: hide “no sponsorship”'): Promise<void> {
    await this.h1bFilter.click()
    await this.page.getByRole('option', { name: option, exact: true }).click()
    await expect(this.h1bFilter).toHaveValue(option)
  }

  async sortBy(option: 'Newest first' | 'Best match'): Promise<void> {
    await this.sort.click()
    await this.page.getByRole('option', { name: option, exact: true }).click()
    await expect(this.sort).toHaveValue(option)
  }

  /** A row's match badge: named "Match 80 of 100", or "Match about 73 of 100, a title-only estimate". */
  matchBadge(title: string): Locator {
    return this.row(title).getByRole('img', { name: /^Match / })
  }

  /** A posted-day button, by its label ("Today", "Yesterday", "Oct 18"); its name ends with the day's count. */
  day(label: string): Locator {
    return this.days.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) })
  }

  async pickDay(label: string): Promise<void> {
    await this.day(label).click()
    await expect(this.day(label)).toHaveAttribute('aria-pressed', 'true')
  }

  /** A workplace segment (a Mantine SegmentedControl radio; its label is clicked), in the Saved tab's words (#189). */
  async workModel(name: 'Any' | 'Remote' | 'Hybrid' | 'Onsite'): Promise<void> {
    const radio = this.page.getByRole('radio', { name, exact: true })
    await radio.locator('xpath=following-sibling::label[1]').click()
    await expect(radio).toBeChecked()
  }

  /** Listed rows' titles, top to bottom. */
  async listedTitles(): Promise<string[]> {
    if ((await this.list.count()) === 0) return []
    return this.list.getByRole('listitem').evaluateAll((items) =>
      items.map((li) => (li.getAttribute('aria-label') ?? '').replace(/ at .*$/, ''))
    )
  }

  /** A row, by its title. */
  row(title: string): Locator {
    return this.list.getByRole('listitem').filter({ has: this.page.getByRole('button', { name: title, exact: true }) })
  }

  /** "Save": keeps the row's job on the Saved tab. */
  addButton(title: string): Locator {
    return this.row(title).getByRole('button', { name: 'Save', exact: true })
  }

  /** "Saved ✓" (#189): the row is saved; clicking it opens the job on the Saved tab. */
  addedButton(title: string): Locator {
    return this.row(title).getByRole('button', { name: 'Saved', exact: true })
  }
}
