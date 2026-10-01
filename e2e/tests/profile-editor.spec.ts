import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { ProfileEditor } from '../pages/profile-editor'
import { Shell } from '../pages/shell'

/**
 * Master profile editor flows on the `demo` workspace: edit and save with
 * the file asserted on disk and after a relaunch, unknown sections kept,
 * the save conflict, the leave guard and closing the window with edits.
 */
test.use({ workspace: 'demo' })

const profileOf = (workspace: string) => readFile(join(workspace, 'master-profile.md'), 'utf8')

async function openEditor(app: { window: import('@playwright/test').Page }, name = 'Alex Rivera'): Promise<ProfileEditor> {
  await new Shell(app.window).goTo('profile')
  const editor = new ProfileEditor(app.window)
  await expect(editor.heading(name)).toBeVisible()
  await expect(editor.savedBadge).toHaveText('Saved in master-profile.md')
  return editor
}

test.describe('profile editor', () => {
  test('edits to contact, summary and a new experience are saved to master-profile.md and survive a relaunch', async ({ app }) => {
    const editor = await openEditor(app)
    const before = await profileOf(app.workspace!)

    await editor.expectTabSelected('Contact')
    await editor.field('Full name').fill('Alex R. Rivera')
    await editor.field('Headline').fill('Staff Backend Engineer')
    await expect(editor.unsavedBadge).toBeVisible()
    await expect(editor.heading('Alex R. Rivera')).toBeVisible()

    await editor.openTab('Summary & skills')
    await editor.field('Summary').fill('Backend engineer with eight years of experience in Go and Python.')

    await editor.openTab(/^Experience \(2\)/)
    await app.window.getByRole('button', { name: 'Add experience' }).click()
    await expect(editor.tab(/^Experience \(3\)/)).toBeVisible()
    await editor.field('Company').fill('Stark Industries')
    await editor.field('Role').fill('Platform Engineer')
    await editor.field('Start').fill('Feb 2016')
    await editor.field('End').fill('May 2018')
    await editor.field('Technologies').fill('Go, Kafka')
    await editor.field('Highlights').fill('Moved the event bus to **Kafka**.\nCut deploy time by **70%**.')
    await expect(editor.entry('Platform Engineer · Stark Industries · Feb 2016 – May 2018')).toBeVisible()

    // Nothing is on disk until Save.
    expect(await profileOf(app.workspace!)).toBe(before)
    await editor.save()
    await expect(editor.notice).toContainText('Saved to master-profile.md.')

    const after = await profileOf(app.workspace!)
    expect(after).toContain('- Name: Alex R. Rivera')
    expect(after).toContain('- Headline: Staff Backend Engineer')
    expect(after).toContain('Backend engineer with eight years of experience in Go and Python.')
    expect(after).toContain('### Stark Industries')
    expect(after).toContain('- Role: Platform Engineer')
    expect(after).toContain('- Technologies: Go, Kafka')
    expect(after).toContain('  - Moved the event bus to **Kafka**.')
    expect(after).toContain('  - Cut deploy time by **70%**.')
    // The sections the editor knows nothing about are rewritten as they were.
    expect(after).toContain('## Volunteering\n\n- Mentor at the Portland Code Club since 2020.')
    expect(after).toContain('## Gaps and constraints\n\n- No Kubernetes in production yet.')

    // Round trip: a fresh app reads the file back into the same form.
    await app.relaunch()
    const again = await openEditor(app, 'Alex R. Rivera')
    await expect(again.field('Full name')).toHaveValue('Alex R. Rivera')
    await expect(again.field('Headline')).toHaveValue('Staff Backend Engineer')
    await again.openTab('Summary & skills')
    await expect(again.field('Summary')).toHaveValue('Backend engineer with eight years of experience in Go and Python.')
    await again.openTab(/^Experience \(3\)/)
    await again.entry('Platform Engineer · Stark Industries · Feb 2016 – May 2018').click()
    await expect(again.field('Technologies')).toHaveValue('Go, Kafka')
    await expect(again.field('Highlights')).toHaveValue('Moved the event bus to **Kafka**.\nCut deploy time by **70%**.')
    await again.openTab('Gaps & notes')
    await expect(again.field('Section title')).toHaveValue('Volunteering')
    await expect(again.field('Section content')).toHaveValue('- Mentor at the Portland Code Club since 2020.')
    await expect(again.savedBadge).toBeVisible()
  })

  test('removing an entry and Discard both work without touching the file until Save', async ({ app }) => {
    const editor = await openEditor(app)
    const before = await profileOf(app.workspace!)

    await editor.openTab(/^Experience \(2\)/)
    await editor.entry('Software Engineer · Globex Corporation · Jun 2018 – Dec 2021').locator('xpath=..').getByRole('button', { name: 'Remove' }).click()
    await expect(editor.tab(/^Experience \(1\)/)).toBeVisible()
    await expect(editor.unsavedBadge).toBeVisible()

    await editor.discardButton.click()
    await expect(editor.tab(/^Experience \(2\)/)).toBeVisible()
    await expect(editor.savedBadge).toBeVisible()
    expect(await profileOf(app.workspace!)).toBe(before)

    await editor.entry('Software Engineer · Globex Corporation · Jun 2018 – Dec 2021').locator('xpath=..').getByRole('button', { name: 'Remove' }).click()
    await editor.save()
    const after = await profileOf(app.workspace!)
    expect(after).not.toContain('### Globex Corporation')
    expect(after).toContain('### Acme Corp')
  })

  test('saving after the file changed on disk is refused with the conflict message; Reload shows the disk version', async ({ app }) => {
    const editor = await openEditor(app)
    await editor.field('Full name').fill('Alex Rivera-Edited')
    await expect(editor.unsavedBadge).toBeVisible()

    // The user (or Claude) edits the file meanwhile.
    await appendFile(join(app.workspace!, 'master-profile.md'), '\n## Awards\n\n- Employee of the month, Acme Corp, 2023.\n')

    await editor.saveButton.click()
    await expect(editor.notice).toContainText('master-profile.md was changed outside Huntgry. Reload it before saving.')
    await expect(editor.notice.getByRole('button', { name: 'Reload from disk (discards edits here)' })).toBeVisible()
    await expect(editor.unsavedBadge).toBeVisible()
    // Neither the edit nor a rewrite landed: the outside change is intact and the name unchanged.
    const disk = await profileOf(app.workspace!)
    expect(disk).toContain('- Name: Alex Rivera\n')
    expect(disk).not.toContain('Alex Rivera-Edited')
    expect(disk).toContain('## Awards')

    await editor.notice.getByRole('button', { name: 'Reload from disk (discards edits here)' }).click()
    await expect(editor.notice).toContainText('Reloaded master-profile.md from disk.')
    await expect(editor.field('Full name')).toHaveValue('Alex Rivera')
    await expect(editor.savedBadge).toBeVisible()
    await editor.openTab('Gaps & notes')
    await expect(editor.field('Section title').nth(1)).toHaveValue('Awards')

    // After the reload the version matches again and a save goes through, keeping the new section.
    await editor.openTab('Contact')
    await editor.field('Full name').fill('Alex Rivera-Edited')
    await editor.save()
    const saved = await profileOf(app.workspace!)
    expect(saved).toContain('- Name: Alex Rivera-Edited')
    expect(saved).toContain('## Awards\n\n- Employee of the month, Acme Corp, 2023.')
  })

  test('navigating away with unsaved edits asks first; Keep editing stays, Discard and leave goes', async ({ app }) => {
    const editor = await openEditor(app)
    const shell = new Shell(app.window)
    const before = await profileOf(app.workspace!)
    await editor.field('Full name').fill('Alex Rivera-Unsaved')

    await shell.navLink('dashboard').click()
    await expect(editor.leaveDialog).toBeVisible()
    await expect(editor.leaveDialog).toContainText('You have edits that are not saved to the master profile yet.')
    await editor.leaveDialog.getByRole('button', { name: 'Keep editing' }).click()
    await expect(editor.leaveDialog).toBeHidden()
    await shell.expectActive('profile')
    await expect(editor.field('Full name')).toHaveValue('Alex Rivera-Unsaved')
    await expect(editor.unsavedBadge).toBeVisible()

    // Switching workspace is guarded the same way.
    await shell.switchWorkspaceButton.click()
    await expect(editor.leaveDialog).toBeVisible()
    await editor.leaveDialog.getByRole('button', { name: 'Keep editing' }).click()
    await shell.expectActive('profile')

    await shell.navLink('dashboard').click()
    await editor.leaveDialog.getByRole('button', { name: 'Discard and leave' }).click()
    await shell.expectActive('dashboard')
    expect(await profileOf(app.workspace!)).toBe(before)

    // Coming back starts from the file, not from the discarded draft.
    await shell.goTo('profile')
    await expect(editor.field('Full name')).toHaveValue('Alex Rivera')
    await expect(editor.savedBadge).toBeVisible()
    // And with nothing unsaved, no question is asked.
    await shell.goTo('dashboard')
    await expect(editor.leaveDialog).toHaveCount(0)
  })

  test('closing the window with unsaved edits asks through showMessageBoxSync and honours the answer', async ({ app }) => {
    const editor = await openEditor(app)
    const before = await profileOf(app.workspace!)
    await editor.field('Full name').fill('Alex Rivera-Closing')
    await expect(editor.unsavedBadge).toBeVisible()

    // Electron answers the beforeunload question itself (will-prevent-unload → showMessageBoxSync), so
    // by the time Playwright hears about the "dialog" there is none to handle; its default handler would
    // raise a protocol error. Listen and ignore instead.
    app.window.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}))

    // Replace the native question with a recording stub that answers `index`.
    const stub = (index: number) =>
      app.electronApp.evaluate(({ dialog }, i) => {
        const g = globalThis as { __messageBoxes?: Array<{ buttons?: string[]; message?: string }> }
        g.__messageBoxes = []
        dialog.showMessageBoxSync = ((_win: unknown, options: { buttons?: string[]; message?: string }) => {
          g.__messageBoxes!.push({ buttons: options.buttons, message: options.message })
          return i
        }) as typeof dialog.showMessageBoxSync
      }, index)
    const asked = () =>
      app.electronApp.evaluate(() => (globalThis as { __messageBoxes?: unknown[] }).__messageBoxes ?? [])
    const windows = () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    const close = () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())

    // 1 = "Keep Editing": the window stays and the edits with it.
    await stub(1)
    await close()
    await expect.poll(asked).toEqual([
      { buttons: ['Close Without Saving', 'Keep Editing'], message: 'You have unsaved changes to your master profile.' }
    ])
    expect(await windows()).toBe(1)
    await expect(editor.field('Full name')).toHaveValue('Alex Rivera-Closing')
    await expect(editor.unsavedBadge).toBeVisible()

    // 0 = "Close Without Saving": the window goes, nothing is written.
    await stub(0)
    await close()
    await expect.poll(windows).toBe(0)
    expect(await asked()).toHaveLength(1)
    expect(await profileOf(app.workspace!)).toBe(before)
  })
})
