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
   * Drops a file on the window the way Finder does: the `File` comes from a file
   * input that Playwright fills with the real path, so the app can resolve it.
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

  /** Drops a `File` built by page script: it has no path on disk, like a forged one. */
  async dropScriptFile(name: string, content: string): Promise<void> {
    await this.page.evaluate(
      ([fileName, text]) => {
        const dt = new DataTransfer()
        dt.items.add(new File([text], fileName))
        for (const type of ['dragenter', 'dragover', 'drop']) {
          document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
        }
      },
      [name, content]
    )
  }
}
