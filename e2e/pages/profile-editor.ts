import { expect, type Locator, type Page } from '@playwright/test'

/** The master profile form inside the shell (Master profile page). */
export class ProfileEditor {
  readonly saveButton: Locator
  readonly discardButton: Locator
  readonly importButton: Locator
  readonly moreButton: Locator
  /** Import / saved / error notices (`role="status"`). */
  readonly notice: Locator
  /** The sticky footer's "Unsaved changes" / "Saved in master-profile.md" line. */
  readonly unsavedBadge: Locator
  readonly savedBadge: Locator
  /** The shell's "Discard unsaved changes?" question when navigating away with edits. */
  readonly leaveDialog: Locator

  constructor(readonly page: Page) {
    this.saveButton = page.getByRole('button', { name: 'Save', exact: true })
    this.discardButton = page.getByRole('button', { name: 'Discard', exact: true })
    this.importButton = page.getByRole('button', { name: 'Import from resume' })
    this.moreButton = page.getByRole('button', { name: 'More', exact: true })
    this.notice = page.getByRole('status')
    this.unsavedBadge = page.getByText('Unsaved changes', { exact: true })
    this.savedBadge = page.getByText(/^Saved in /)
    this.leaveDialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' })
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

  async openTab(name: RegExp | string): Promise<void> {
    await this.tab(name).click()
    await this.expectTabSelected(name)
  }

  /**
   * A labelled field of the open tab. Collapsed accordion entries keep their
   * fields mounted but hidden, so only the visible match counts.
   */
  field(label: string): Locator {
    return this.page.getByLabel(label, { exact: true }).filter({ visible: true })
  }

  /** The accordion header of an experience/project/education entry. */
  entry(title: RegExp | string): Locator {
    return this.page.getByRole('button', { name: title })
  }

  async save(): Promise<void> {
    await this.saveButton.click()
    await expect(this.notice.filter({ hasText: /^Saved to / })).toBeVisible()
    await expect(this.savedBadge).toBeVisible()
  }
}
