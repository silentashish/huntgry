import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { resumeFixture, stubOpenDialog } from '../fixtures/workspace'
import { ProfileEditor } from '../pages/profile-editor'
import { ProfileSetup } from '../pages/profile-setup'
import { Shell } from '../pages/shell'

// A workspace whose master profile is empty starts on the setup step, like right after Create.
test.use({ workspace: 'empty-profile' })

test.describe('profile setup', () => {
  test('"Fill it in manually" opens the editor on the Contact tab', async ({ app }) => {
    const setup = new ProfileSetup(app.window)
    await setup.expectVisible(app.workspace!)
    await setup.manualButton.click()

    const shell = new Shell(app.window)
    await shell.expectVisible(app.workspace!)
    await shell.expectActive('profile')
    const editor = new ProfileEditor(app.window)
    await editor.expectTabSelected('Contact')
    await expect(editor.heading('Your master profile')).toBeVisible()
    await expect(app.window.getByLabel('Full name', { exact: true })).toHaveValue('')
    await expect(editor.saveButton).toBeDisabled()
  })

  test('a cancelled resume dialog leaves the setup step as it was', async ({ app }) => {
    const setup = new ProfileSetup(app.window)
    await stubOpenDialog(app.electronApp, null)
    await setup.importButton.click()
    await setup.expectVisible(app.workspace!)
    await expect(setup.error).toHaveCount(0)
  })

  test('"Import from a resume" parses the .docx, shows the review form and saves master-profile.md', async ({ app }) => {
    const setup = new ProfileSetup(app.window)
    await stubOpenDialog(app.electronApp, [resumeFixture('sample-resume.docx')])
    await setup.importButton.click()

    const shell = new Shell(app.window)
    await shell.expectActive('profile')
    const editor = new ProfileEditor(app.window)
    await expect(editor.notice).toContainText('Imported from sample-resume.docx')
    await editor.expectTabSelected('Contact')
    await expect(editor.heading('Jordan Example')).toBeVisible()
    await expect(app.window.getByLabel('Full name', { exact: true })).toHaveValue('Jordan Example')
    await expect(app.window.getByLabel('Email', { exact: true })).toHaveValue('jordan.example@example.com')
    await expect(editor.tab(/^Experience \(2\)/)).toBeVisible()

    // Nothing is on disk until Save.
    const profilePath = join(app.workspace!, 'master-profile.md')
    expect(await readFile(profilePath, 'utf8')).not.toContain('Jordan Example')
    await editor.save()
    const saved = await readFile(profilePath, 'utf8')
    expect(saved).toContain('- Name: Jordan Example')
    expect(saved).toContain('### Vandelay Industries')

    // Saved, so leaving the editor needs no confirmation and the dashboard opens.
    await shell.goTo('dashboard')
    await expect(app.window.getByRole('dialog')).toHaveCount(0)
    await expect(app.window.getByRole('heading', { name: 'No applications yet' })).toBeVisible()
  })

  test('"Import from a resume" also reads the .pdf sample', async ({ app }) => {
    const setup = new ProfileSetup(app.window)
    await stubOpenDialog(app.electronApp, [resumeFixture('sample-resume.pdf')])
    await setup.importButton.click()

    const editor = new ProfileEditor(app.window)
    await expect(editor.notice).toContainText('Imported from sample-resume.pdf')
    await expect(app.window.getByLabel('Full name', { exact: true })).toHaveValue('Jordan Example')
  })
})
