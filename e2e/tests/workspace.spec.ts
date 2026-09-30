import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { seedWorkspace, stubOpenDialog } from '../fixtures/workspace'
import { ProfileSetup } from '../pages/profile-setup'
import { Shell } from '../pages/shell'
import { WorkspacePicker } from '../pages/workspace-picker'

const exists = (path: string) => access(path).then(() => true, () => false)

test.describe('workspace picker', () => {
  test('first launch shows the picker with Create and Import', async ({ app }) => {
    const picker = new WorkspacePicker(app.window)
    await picker.expectVisible()
    await expect(picker.notice).toHaveCount(0)
    await expect(app.window.getByRole('heading', { name: 'Huntgry' })).toBeVisible()
  })

  test('Create on a missing folder writes the three files and lands on profile setup', async ({ app }) => {
    const picker = new WorkspacePicker(app.window)
    const target = join(app.sandbox.workspaces, 'new-workspace')
    await picker.typePath(target)
    await picker.expectStatus('missing')
    await picker.createHereButton.click()

    await new ProfileSetup(app.window).expectVisible(target)
    for (const file of ['master-profile.md', 'cover-letter.md', 'CLAUDE.md']) {
      expect(await exists(join(target, file)), file).toBe(true)
    }
    // The empty-profile fixture is what Create writes; keep them in sync.
    const fixture = join(__dirname, '../fixtures/workspaces/empty-profile')
    expect(await readFile(join(target, 'master-profile.md'), 'utf8')).toBe(await readFile(join(fixture, 'master-profile.md'), 'utf8'))
    expect(await readFile(join(target, 'cover-letter.md'), 'utf8')).toBe(await readFile(join(fixture, 'cover-letter.md'), 'utf8'))
    expect(await readFile(join(target, 'CLAUDE.md'), 'utf8')).toContain(target)
    // The workspace is remembered in the sandbox's userData, nowhere else.
    const settings = JSON.parse(await readFile(join(app.userData, 'settings.json'), 'utf8'))
    expect(settings.currentWorkspace).toBe(target)
  })

  test('Create on a non-empty unrelated folder asks for confirmation first', async ({ app }) => {
    const picker = new WorkspacePicker(app.window)
    const target = await seedWorkspace('not-a-workspace', app.sandbox.workspaces)
    await picker.typePath(target)
    await picker.expectStatus('not-a-workspace')
    await picker.createHereButton.click()

    await expect(picker.confirmDialog).toBeVisible()
    await picker.confirmDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(picker.confirmDialog).toBeHidden()
    expect(await exists(join(target, 'master-profile.md'))).toBe(false)

    await picker.createHereButton.click()
    await picker.confirmAddFiles()
    await new ProfileSetup(app.window).expectVisible(target)
    expect(await exists(join(target, 'master-profile.md'))).toBe(true)
    // Nothing that was there is touched.
    expect(await readFile(join(target, 'notes.txt'), 'utf8')).toContain('Shopping list')
  })

  test('Import of a valid workspace opens the shell on the dashboard', async ({ app }) => {
    const picker = new WorkspacePicker(app.window)
    const demo = await seedWorkspace('demo', app.sandbox.workspaces)
    await picker.typePath(demo)
    await picker.expectStatus('valid')
    await picker.importHereButton.click()

    const shell = new Shell(app.window)
    await shell.expectVisible(demo)
    await shell.expectActive('dashboard')
  })

  test('Import of a folder without a master profile is refused and offers Create', async ({ app }) => {
    const picker = new WorkspacePicker(app.window)
    const target = await seedWorkspace('not-a-workspace', app.sandbox.workspaces)

    // A cancelled native dialog changes nothing.
    await stubOpenDialog(app.electronApp, null)
    await picker.importButton.click()
    await picker.expectVisible()
    await expect(picker.notice).toHaveCount(0)

    await stubOpenDialog(app.electronApp, [target])
    await picker.importButton.click()
    await expect(picker.notice).toContainText(`No master profile (master-profile.md) was found in ${target}`)
    await expect(picker.importHereButton).toHaveCount(0)

    // The offer leads into Create, which still asks before touching a non-empty folder.
    await picker.notice.getByRole('button', { name: 'Create workspace here' }).click()
    await picker.confirmAddFiles()
    await new ProfileSetup(app.window).expectVisible(target)
  })

  test('Import of a legacy workspace (master_profile.md) works', async ({ app }) => {
    const picker = new WorkspacePicker(app.window)
    const legacy = await seedWorkspace('legacy', app.sandbox.workspaces)
    await picker.typePath(legacy)
    await picker.expectStatus('legacy')
    await expect(app.window.getByText('master_profile.md', { exact: true })).toBeVisible()
    await picker.importHereButton.click()
    await new Shell(app.window).expectVisible(legacy)
  })

  test('a typed ~ expands to the sandbox HOME', async ({ app }) => {
    const picker = new WorkspacePicker(app.window)
    const inHome = await seedWorkspace('demo', app.home, 'cv')
    expect(inHome).toBe(join(app.home, 'cv'))
    await picker.typePath('~/cv', inHome)
    await picker.expectStatus('valid')
    await picker.importHereButton.click()
    await new Shell(app.window).expectVisible(inHome)
  })
})

test.describe('remembered workspace', () => {
  test.use({ workspace: 'demo' })

  test('a relaunch opens the last workspace directly', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.expectVisible(app.workspace!)
    await shell.goTo('settings')

    await app.relaunch()
    const again = new Shell(app.window)
    await again.expectVisible(app.workspace!)
    await again.expectActive('dashboard')
    await expect(app.window.getByRole('button', { name: 'Create New Workspace' })).toHaveCount(0)
  })

  test('a remembered workspace whose profile was deleted shows the notice and offers Create', async ({ app }) => {
    await new Shell(app.window).expectVisible(app.workspace!)
    await rm(join(app.workspace!, 'master-profile.md'))

    await app.relaunch()
    const picker = new WorkspacePicker(app.window)
    await picker.expectVisible()
    await expect(picker.notice).toContainText(`The last workspace (${app.workspace}) no longer has a master profile.`)
    await expect(picker.notice.getByRole('button', { name: 'Create workspace here' })).toBeVisible()
  })

  test('Switch workspace returns to the picker', async ({ app }) => {
    const shell = new Shell(app.window)
    await shell.expectVisible(app.workspace!)
    await shell.switchWorkspaceButton.click()
    await new WorkspacePicker(app.window).expectVisible()
  })
})
