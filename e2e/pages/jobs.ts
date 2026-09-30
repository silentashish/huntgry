import { expect, type Locator, type Page } from '@playwright/test'

/** The Jobs page: board search, add by URL, paste, the saved-job list with selection, the job drawer and "Tailor all". */
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
