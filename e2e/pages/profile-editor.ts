import { expect, type Locator, type Page } from '@playwright/test'

/** The views of the Profile page, by their label in the view switcher. */
export type ProfileViewName = 'Editor' | 'Knowledge graph' | 'Skills'

/** The master profile form on the Profile page (its Editor view). */
export class ProfileEditor {
  readonly saveButton: Locator
  readonly discardButton: Locator
  readonly importButton: Locator
  readonly moreButton: Locator
  /** Import / saved / error notices (`role="status"`). */
  readonly notice: Locator
  /** The floating save bar's "Unsaved changes · N fields", shown while the form differs from the file. */
  readonly unsavedBadge: Locator
  /** "Saved in master-profile.md" beside the view switcher, shown while nothing is unsaved. */
  readonly savedBadge: Locator
  /** The shell's "Discard unsaved changes?" question when navigating away with edits. */
  readonly leaveDialog: Locator
  /** Editor · Knowledge graph · Skills. */
  readonly viewSwitch: Locator

  constructor(readonly page: Page) {
    this.saveButton = page.getByRole('button', { name: /^Save to / })
    this.discardButton = page.getByRole('button', { name: 'Discard', exact: true })
    this.importButton = page.getByRole('button', { name: 'Import from resume' })
    this.moreButton = page.getByRole('button', { name: 'More', exact: true })
    this.notice = page.getByRole('status')
    this.unsavedBadge = page.getByText(/^Unsaved changes · \d+ fields?$/)
    this.savedBadge = page.getByText(/^Saved in \S+$/)
    this.leaveDialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' })
    this.viewSwitch = page.getByRole('radiogroup', { name: 'Profile view' })
  }

  /** A section of the form, in the section list on the left (named "Experience (2)" with its count). */
  tab(name: RegExp | string): Locator {
    return this.page.getByRole('tab', { name })
  }

  /** The header card's title: the profile's name, or "Your master profile" while empty. */
  heading(name: string): Locator {
    return this.page.getByRole('heading', { name, level: 3 }).first()
  }

  async expectTabSelected(name: RegExp | string): Promise<void> {
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true')
  }

  async openTab(name: RegExp | string): Promise<void> {
    await this.tab(name).click()
    await this.expectTabSelected(name)
  }

  view(name: ProfileViewName): Locator {
    return this.viewSwitch.getByRole('radio', { name, exact: true })
  }

  async expectView(name: ProfileViewName): Promise<void> {
    await expect(this.view(name)).toBeChecked()
  }

  /** Switches the Profile page to a view with its view switcher. */
  async showView(name: ProfileViewName): Promise<void> {
    await this.viewSwitch.getByText(name, { exact: true }).click()
    await this.expectView(name)
  }

  /**
   * A labelled field of the open section. Collapsed entries keep their
   * fields mounted but hidden, so only the visible match counts.
   */
  field(label: string): Locator {
    return this.page.getByLabel(label, { exact: true }).filter({ visible: true })
  }

  /** The header of an experience/project/education entry card (named "<title> · <dates>"). */
  entry(title: RegExp | string): Locator {
    return this.page.getByRole('button', { name: title })
  }

  async save(): Promise<void> {
    await this.saveButton.click()
    await expect(this.notice.filter({ hasText: /^Saved to / })).toBeVisible()
    await expect(this.savedBadge).toBeVisible()
  }
}
