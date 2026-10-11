import { expect, type Locator, type Page } from '@playwright/test'

/** The step after Create (or an empty profile): import a resume (picked or dropped) or start with an empty form. */
export class ProfileSetup {
  /** The setup step (a region named "Set up your master profile"). */
  readonly section: Locator
  readonly importButton: Locator
  readonly manualButton: Locator
  readonly error: Locator

  constructor(readonly page: Page) {
    this.section = page.getByRole('region', { name: 'Set up your master profile' })
    this.importButton = page.getByRole('button', { name: 'Choose resume file…' })
    this.manualButton = page.getByRole('button', { name: 'Start with an empty form' })
    this.error = page.getByRole('status')
  }

  async expectVisible(workspacePath?: string): Promise<void> {
    await expect(this.section).toBeVisible()
    await expect(this.section.getByRole('heading', { name: 'Import from a resume' })).toBeVisible()
    if (workspacePath) await expect(this.section.getByText(workspacePath, { exact: true })).toBeVisible()
  }

  /**
   * Drops a file from disk on the window the way Finder does: the `File` comes from
   * a file input that Playwright fills from `path` (the app sends its bytes to main).
   */
  async dropFile(path: string): Promise<void> {
    const input = await this.page.evaluateHandle(() => {
      const el = document.createElement('input')
      el.type = 'file'
      el.style.display = 'none'
      document.body.append(el)
      return el
    })
    await input.asElement()!.setInputFiles(path)
    await input.evaluate((el: HTMLInputElement) => {
      const dt = new DataTransfer()
      dt.items.add(el.files![0])
      el.remove()
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
      }
    })
  }

  /** Drops files built in the page from text (no path on disk); several at once when given several. */
  async dropFiles(files: Array<{ name: string; content: string }>): Promise<void> {
    await this.page.evaluate((list) => {
      const dt = new DataTransfer()
      for (const f of list) dt.items.add(new File([f.content], f.name))
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
      }
    }, files)
  }
}
