import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The Dashboard page: summary cards, search and status filters, the
 * applications table and the application drawer. Rows are addressed by
 * company (the first line of the Application cell), never by position: the
 * table is ordered by file mtime, which a fresh workspace copy does not fix.
 */
export type StatLabel = 'Total' | 'Generated' | 'Applied' | 'Interviewing' | 'Offer' | 'Rejected'

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
    // The visible h2 is the greeting ("Good morning, Alex." / "Welcome to the den."); its accessible
    // name starts with a visually hidden "Dashboard:", so the page still announces itself by name.
    this.heading = page.getByRole('heading', { name: /^Dashboard:/, level: 2 })
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
   * The stat tile of a status ("Total", "Applied", …): a toggle button (`aria-pressed`) whose
   * accessible name starts with the label. Clicking it filters the table to that status.
   */
  statCard(label: StatLabel): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^${label}(?![A-Za-z])`) }).and(this.page.locator('[aria-pressed]'))
  }

  /** The count shown on a stat tile. */
  statValue(label: StatLabel): Locator {
    return this.statCard(label).getByTestId('stat-value')
  }

  /** A tooltip with this text. A disabled control gets no mouseleave, so its tooltip may stay open: match by text. */
  tooltip(text: string | RegExp): Locator {
    return this.page.getByRole('tooltip', { name: text }).filter({ visible: true })
  }

  /** The status pill of a row: a menu button named "Status: <status>", showing the status as its text. */
  rowStatus(company: string): Locator {
    return this.row(company).getByRole('button', { name: /^Status: / })
  }

  /** Picks `status` from a row's status menu and waits for the pill to show it. */
  async setRowStatus(company: string, status: string): Promise<void> {
    await this.rowStatus(company).click()
    await this.page.getByRole('menuitem', { name: status, exact: true }).click()
    await expect(this.rowStatus(company)).toHaveText(status)
  }

  /** Picks `status` in a Mantine Select (the drawer's Status, the sort): open it, click the option, wait for the value. */
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
