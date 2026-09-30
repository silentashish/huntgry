import { expect, type Locator, type Page } from '@playwright/test'

/** The step after Create (or an empty profile): import a resume or start with an empty form. */
export class ProfileSetup {
  readonly heading: Locator
  readonly importButton: Locator
  readonly manualButton: Locator
  readonly error: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Set up your master profile' })
    this.importButton = page.getByRole('button', { name: 'Choose resume file…' })
    this.manualButton = page.getByRole('button', { name: 'Start with an empty form' })
    this.error = page.getByRole('status')
  }

  async expectVisible(workspacePath?: string): Promise<void> {
    await expect(this.heading).toBeVisible()
    if (workspacePath) await expect(this.page.getByText(workspacePath, { exact: true })).toBeVisible()
  }
}
