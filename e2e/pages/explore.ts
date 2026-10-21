import { expect, type Locator, type Page } from '@playwright/test'

/** The Explore page (#142): Jobright's daily list, its posted-day buttons, filters and per-row Add to Jobs. */
export class ExplorePage {
  readonly heading: Locator
  readonly refreshButton: Locator
  readonly filterInput: Locator
  readonly days: Locator
  readonly list: Locator
  readonly error: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Explore', level: 2 })
    this.refreshButton = page.getByRole('button', { name: 'Refresh', exact: true }).first()
    this.filterInput = page.getByRole('textbox', { name: 'Filter Jobright jobs' })
    this.days = page.getByRole('group', { name: 'Posted day' })
    this.list = page.getByRole('list', { name: 'Jobright jobs' })
    this.error = page.getByRole('alert').filter({ hasText: 'The Jobright list could not be loaded' })
  }

  /** A posted-day button, by its label ("Today", "Yesterday", "Oct 18"); its name ends with the day's count. */
  day(label: string): Locator {
    return this.days.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) })
  }

  async pickDay(label: string): Promise<void> {
    await this.day(label).click()
    await expect(this.day(label)).toHaveAttribute('aria-pressed', 'true')
  }

  /** A work-model segment (a Mantine SegmentedControl radio; its label is clicked). */
  async workModel(name: 'Any' | 'Remote' | 'Hybrid' | 'On Site'): Promise<void> {
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

  addButton(title: string): Locator {
    return this.row(title).getByRole('button', { name: 'Add to Jobs' })
  }

  addedButton(title: string): Locator {
    return this.row(title).getByRole('button', { name: 'Added' })
  }
}
