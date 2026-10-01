import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The Dashboard page: summary cards, search and status filters, the
 * applications table and the application drawer. Rows are addressed by
 * company (the first line of the Application cell), never by position: the
 * table is ordered by file mtime, which a fresh workspace copy does not fix.
 */
export class Dashboard {
  readonly heading: Locator
  readonly refreshButton: Locator
  /** The search, status and sort controls, by the accessible names the page gives them (`aria-label`). */
  readonly searchInput: Locator
  readonly statusFilter: Locator
  readonly sortSelect: Locator
  readonly table: Locator
  /** The "Nothing matches" line with its Clear filters link. */
  readonly nothingMatches: Locator
  readonly clearFiltersLink: Locator
  readonly emptyState: Locator
  readonly drawer: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Dashboard', level: 2 })
    this.refreshButton = page.getByRole('button', { name: 'Refresh' })
    this.searchInput = page.getByRole('textbox', { name: 'Search applications' })
    this.statusFilter = page.getByRole('combobox', { name: 'Filter by status' })
    this.sortSelect = page.getByRole('combobox', { name: 'Sort applications' })
    this.table = page.getByRole('table')
    this.nothingMatches = page.getByText('Nothing matches.')
    this.clearFiltersLink = page.getByRole('button', { name: 'Clear filters' })
    this.emptyState = page.getByRole('heading', { name: 'No applications yet' })
    this.drawer = page.getByRole('dialog')
  }

  /** Data rows: every row that carries the Apply control (the header row has none). */
  get rows(): Locator {
    return this.table.getByRole('row').filter({ has: this.page.getByRole('button', { name: 'Apply', exact: true }) })
  }

  /** The row of one application, by the humanized company name shown on its first line. */
  row(company: string): Locator {
    return this.rows.filter({ has: this.page.getByText(company, { exact: true }) })
  }

  /**
   * The summary card of a status ("Total", "Applied", …): the card around the
   * visible label (the status selects keep their option lists mounted but
   * hidden, so the label text alone is ambiguous). Its text is `<label><count>`.
   */
  statCard(label: 'Total' | 'Generated' | 'Applied' | 'Interviewing' | 'Offer' | 'Rejected'): Locator {
    return this.page.getByText(label, { exact: true }).filter({ visible: true }).locator('xpath=..')
  }

  /** A tooltip with this text. A disabled control gets no mouseleave, so its tooltip may stay open: match by text. */
  tooltip(text: string | RegExp): Locator {
    return this.page.getByRole('tooltip', { name: text }).filter({ visible: true })
  }

  /** The status combobox inside a row. */
  rowStatus(company: string): Locator {
    return this.row(company).getByRole('combobox')
  }

  /** Picks `status` in a Mantine Select: open it, click the option, wait for the value. */
  async pickStatus(select: Locator, status: string): Promise<void> {
    await select.click()
    await this.page.getByRole('option', { name: status, exact: true }).click()
    await expect(select).toHaveValue(status)
  }

  /** Opens the drawer of one application by clicking its company name. */
  async open(company: string): Promise<Locator> {
    await this.row(company).getByText(company, { exact: true }).click()
    await expect(this.drawer).toBeVisible()
    await expect(this.drawer.getByRole('heading', { level: 2 })).toContainText(company)
    return this.drawer
  }

  async closeDrawer(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.drawer).toBeHidden()
  }

  /** Waits until the table lists exactly these companies (any order). */
  async expectCompanies(companies: string[]): Promise<void> {
    await expect(this.rows).toHaveCount(companies.length)
    for (const c of companies) await expect(this.row(c)).toHaveCount(1)
  }
}
