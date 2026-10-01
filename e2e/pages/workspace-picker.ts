import { expect, type Locator, type Page } from '@playwright/test'

/** The first screen: Create / Import buttons, the typed-path input, the status card and notices. */
export class WorkspacePicker {
  readonly createButton: Locator
  readonly importButton: Locator
  readonly pathInput: Locator
  /** Green/red/yellow notices under the input (`role="status"`). */
  readonly notice: Locator
  readonly createHereButton: Locator
  readonly importHereButton: Locator
  /** "Add a workspace to this folder?" confirmation for non-empty folders. */
  readonly confirmDialog: Locator

  constructor(readonly page: Page) {
    this.createButton = page.getByRole('button', { name: 'Create New Workspace' })
    this.importButton = page.getByRole('button', { name: 'Import Existing Workspace' })
    this.pathInput = page.getByLabel('Or type a folder path')
    this.notice = page.getByRole('status')
    this.createHereButton = page.getByRole('button', { name: 'Create workspace here' })
    this.importHereButton = page.getByRole('button', { name: 'Import this workspace' })
    this.confirmDialog = page.getByRole('dialog', { name: 'Add a workspace to this folder?' })
  }

  async expectVisible(): Promise<void> {
    await expect(this.page.getByText('Set up the working directory for the Claude resume-tailor skill.')).toBeVisible()
    await expect(this.createButton).toBeVisible()
    await expect(this.importButton).toBeVisible()
  }

  /** Types a path and waits for the status card to show the inspected (real, `~`-expanded) path. */
  async typePath(path: string, expectedPath = path): Promise<void> {
    await this.pathInput.fill(path)
    await expect(this.page.getByText(expectedPath, { exact: true })).toBeVisible()
  }

  /** The status badge of the inspected folder: `valid`, `legacy`, `empty`, `missing`, `not-a-workspace`, … */
  async expectStatus(status: string): Promise<void> {
    await expect(this.page.getByText(status, { exact: true })).toBeVisible()
  }

  /** Confirms adding the workspace files to a non-empty folder. */
  async confirmAddFiles(): Promise<void> {
    await expect(this.confirmDialog).toBeVisible()
    await this.confirmDialog.getByRole('button', { name: 'Add workspace files' }).click()
  }
}
