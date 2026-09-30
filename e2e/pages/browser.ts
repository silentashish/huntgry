import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The Browser page: the tab strip, the toolbar, the notice row and the Apply
 * panel beside the page. The pages themselves are native views (see
 * e2e/fixtures/tabs.ts for reading them).
 */
export class BrowserPage {
  readonly address: Locator
  readonly backButton: Locator
  readonly forwardButton: Locator
  readonly reloadButton: Locator
  readonly stopButton: Locator
  readonly newTabButton: Locator
  readonly openInBrowserButton: Locator
  /** The red notice under the toolbar: a refused address or a failed load. */
  readonly notice: Locator
  readonly emptyState: Locator
  readonly apply: ApplyPanel

  constructor(readonly page: Page) {
    this.address = page.getByLabel('Address', { exact: true })
    this.backButton = page.getByRole('button', { name: 'Back', exact: true })
    this.forwardButton = page.getByRole('button', { name: 'Forward', exact: true })
    this.reloadButton = page.getByRole('button', { name: 'Reload', exact: true })
    this.stopButton = page.getByRole('button', { name: 'Stop', exact: true })
    this.newTabButton = page.getByRole('button', { name: 'New tab', exact: true })
    this.openInBrowserButton = page.getByRole('button', { name: 'Open in browser' })
    this.notice = page.getByRole('alert')
    this.emptyState = page.getByText('No pages open')
    this.apply = new ApplyPanel(page)
  }

  /** A tab in the strip, by its label (the page title, else its host, else "New tab"); tabs carry their URL as `title`. */
  tab(label: string): Locator {
    return this.page.getByRole('button', { name: label, exact: true }).and(this.page.locator('button[title]'))
  }

  closeTab(label: string): Locator {
    return this.page.getByRole('button', { name: `Close ${label}`, exact: true })
  }

  /** Types an address and presses Enter. */
  async go(text: string): Promise<void> {
    await this.address.fill(text)
    await this.address.press('Enter')
  }

  async expectNotice(text: string): Promise<void> {
    await expect(this.notice).toContainText(text)
  }
}

/** The auto-apply panel beside the page (shown while a session exists). */
export class ApplyPanel {
  readonly endButton: Locator
  readonly fillButton: Locator
  readonly markAppliedButton: Locator
  readonly notYetButton: Locator
  readonly openAgainButton: Locator
  readonly confirmedText: Locator

  constructor(readonly page: Page) {
    this.endButton = page.getByRole('button', { name: 'End apply session' })
    this.fillButton = page.getByRole('button', { name: /^Fill (form|again)$/ })
    this.markAppliedButton = page.getByRole('button', { name: 'Mark as applied' })
    this.notYetButton = page.getByRole('button', { name: 'Not yet' })
    this.openAgainButton = page.getByRole('button', { name: 'Open again' })
    this.confirmedText = page.getByText('The site says the application was submitted.')
  }

  /** The status badge: "Loading page", "Ready to fill", "Filling", "Filled: review and submit", "Submitted", "Human check", "Tab closed", "Error". */
  status(label: string): Locator {
    return this.page.getByText(label, { exact: true })
  }

  /** A report group heading, e.g. "Filled (7)". */
  group(title: 'Needs you' | 'Filled' | 'Your choice'): Locator {
    return this.page.getByText(new RegExp(`^${title} \\(\\d+\\)$`))
  }

  /** The row of a reported field: its label, outcome badge and value. */
  field(label: string): Locator {
    return this.page.getByText(label, { exact: true }).locator('..').locator('..')
  }

  async expectStatus(label: string): Promise<void> {
    await expect(this.status(label)).toBeVisible()
  }
}
