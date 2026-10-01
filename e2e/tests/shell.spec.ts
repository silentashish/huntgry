import { expect, test } from '../fixtures/app'
import { ProfileEditor } from '../pages/profile-editor'
import { SHELL_PAGES, Shell, type ShellPage } from '../pages/shell'

test.use({ workspace: 'demo' })

test.describe('app shell', () => {
  test('every navbar entry opens its page', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.expectVisible(app.workspace!)
    await shell.expectActive('dashboard')

    for (const name of Object.keys(SHELL_PAGES) as ShellPage[]) {
      await shell.goTo(name)
      // Only this entry is the current page; every other entry carries no aria-current at all.
      for (const other of Object.keys(SHELL_PAGES) as ShellPage[]) {
        if (other !== name) await expect(shell.navLink(other)).not.toHaveAttribute('aria-current')
      }
      switch (name) {
        case 'browser':
          await expect(app.window.getByLabel('Address')).toBeVisible()
          break
        case 'profile':
          await expect(new ProfileEditor(app.window).heading('Alex Rivera')).toBeVisible()
          break
      }
    }
  })

  test('the dashboard lists the demo applications', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.expectActive('dashboard')
    await expect(app.window.getByText('Acme', { exact: true }).first()).toBeVisible()
    await expect(app.window.getByText('Globex', { exact: true }).first()).toBeVisible()
    await expect(app.window.getByRole('heading', { name: 'No applications yet' })).toHaveCount(0)
  })
})
