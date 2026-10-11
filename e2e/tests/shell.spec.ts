import { expect, test } from '../fixtures/app'
import { ProfileEditor } from '../pages/profile-editor'
import { SHELL_PAGES, Shell, type ShellPage } from '../pages/shell'

test.use({ workspace: 'demo' })

test.describe('app shell', () => {
  test('every navbar entry opens its page', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.expectVisible(app.workspace!)
    await shell.expectActive('dashboard')
    // 8 entries: the Knowledge graph moved into Profile (#108).
    await expect(shell.navbar.getByRole('button', { name: /^Knowledge graph/ })).toHaveCount(0)
    await expect(shell.navbar.getByRole('button', { name: /^Master profile/ })).toHaveCount(0)

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

  test('the sidebar shows the version and switches the theme', async ({ app }) => {
    const shell = new Shell(app.window)
    await expect(shell.navbar.getByText(/^v\d+\.\d+ · the hound$/)).toBeVisible()
    const html = app.window.locator('html')

    await shell.themeButton('Light').click()
    await expect(shell.themeButton('Light')).toHaveAttribute('aria-pressed', 'true')
    await expect(html).toHaveAttribute('data-mantine-color-scheme', 'light')
    await shell.themeButton('Dark').click()
    await expect(html).toHaveAttribute('data-mantine-color-scheme', 'dark')
    await expect(shell.themeButton('Light')).toHaveAttribute('aria-pressed', 'false')
    await shell.themeButton('System').click()
    await expect(shell.themeButton('System')).toHaveAttribute('aria-pressed', 'true')
  })
})

test.describe('command palette (⌘K)', () => {
  test('opens from the keyboard and the sidebar, and closes with Escape', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.expectActive('dashboard')

    await shell.openPalette('keyboard')
    // Before typing: the pages to go to and the general actions.
    await expect(shell.paletteGroup('Go to').getByRole('option')).toHaveCount(8)
    await expect(shell.paletteOption('New tailored resume')).toBeVisible()
    await app.window.keyboard.press('Escape')
    await expect(shell.palette).toBeHidden()

    await shell.openPalette('button')
    await app.window.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await expect(shell.palette).toBeHidden()
  })

  test('jumps to a page with the arrow keys and Enter', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.openPalette()
    await shell.paletteInput.fill('settings')
    // The best match is selected first.
    await expect(shell.paletteOption('Settings')).toHaveAttribute('aria-selected', 'true')
    await app.window.keyboard.press('Enter')
    await expect(shell.palette).toBeHidden()
    await shell.expectActive('settings')

    await shell.openPalette()
    await shell.paletteInput.fill('o')
    const first = shell.paletteResults.getByRole('option').first()
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await app.window.keyboard.press('ArrowDown')
    await expect(first).toHaveAttribute('aria-selected', 'false')
    await expect(shell.paletteResults.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
    await app.window.keyboard.press('ArrowUp')
    await expect(first).toHaveAttribute('aria-selected', 'true')

    await shell.paletteInput.fill('board')
    await expect(shell.paletteOption('Board')).toHaveAttribute('aria-selected', 'true')
    await app.window.keyboard.press('Enter')
    await shell.expectActive('board')
  })

  test('finds applications, jobs and runs, and offers their actions', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.openPalette()
    await shell.paletteInput.fill('globex')
    await expect(shell.paletteGroup(/^Applications · \d+$/).getByRole('option', { name: /^Globex/ }).first()).toBeVisible()
    await expect(shell.paletteGroup('Actions').getByRole('option', { name: /^Show the folder/ })).toBeVisible()

    await shell.paletteInput.fill('initech')
    const jobs = shell.paletteGroup(/^Jobs · \d+$/)
    await expect(jobs.getByRole('option', { name: /^Initech · Staff Backend Engineer/ })).toBeVisible()
    await expect(shell.paletteOption('Tailor a resume for Initech…')).toBeVisible()

    // Tailor a resume for the job: the Tailor form opens on it.
    await shell.paletteOption('Tailor a resume for Initech…').click()
    await expect(shell.palette).toBeHidden()
    await shell.expectActive('tailor')
  })

  test('the Knowledge graph opens as a view of Profile', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.openGraph()
    await expect(shell.navLink('profile')).toHaveAttribute('aria-current', 'page')
  })

  test('New tailored resume and Settings sections open their page', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.sniff('new tailored', 'New tailored resume')
    await shell.expectActive('tailor')
    await shell.sniff('pricing', 'Settings → Pricing')
    await shell.expectActive('settings')
  })

  test('typing in a text field is not taken over, and ⌘K still opens from there', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.goTo('jobs')
    const field = app.window.getByRole('textbox').first()
    await field.click()
    await app.window.keyboard.type('kafka')
    await expect(field).toHaveValue('kafka')
    await shell.openPalette()
    await app.window.keyboard.press('Escape')
    await expect(shell.palette).toBeHidden()
    await expect(field).toHaveValue('kafka')
  })
})
