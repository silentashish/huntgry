import { expect, type Locator, type Page } from '@playwright/test'

/** The master profile form inside the shell (Master profile page). */
export class ProfileEditor {
  readonly saveButton: Locator
  readonly discardButton: Locator
  readonly importButton: Locator
  /** Import / saved / error notices (`role="status"`). */
  readonly notice: Locator

  constructor(readonly page: Page) {
    this.saveButton = page.getByRole('button', { name: 'Save', exact: true })
    this.discardButton = page.getByRole('button', { name: 'Discard', exact: true })
    this.importButton = page.getByRole('button', { name: 'Import from resume' })
    this.notice = page.getByRole('status')
  }

  tab(name: RegExp | string): Locator {
    return this.page.getByRole('tab', { name })
  }

  /** The card title: the profile's name, or "Your master profile" while empty. */
  heading(name: string): Locator {
    return this.page.getByRole('heading', { name, level: 3 })
  }

  async expectTabSelected(name: RegExp | string): Promise<void> {
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true')
  }

  async save(): Promise<void> {
    await this.saveButton.click()
    await expect(this.notice.filter({ hasText: /^Saved to / })).toBeVisible()
  }
}
