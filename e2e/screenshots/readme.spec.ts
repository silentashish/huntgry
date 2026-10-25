import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '../fixtures/servers/fixture'
import { withFakeAgents } from '../fixtures/fake-agent'
import { expectTabLoaded } from '../fixtures/tabs'
import { BoardPage } from '../pages/board'
import { BrowserPage } from '../pages/browser'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'

/**
 * The README screenshots (#132), taken from the built app with the e2e
 * fixture workspaces: every person, company and posting is fictional. Run with
 * `npm run screenshots` (builds first); see docs/changes/132-readme-refresh.md.
 */

const OUT = resolve(__dirname, '../../docs/assets/screenshots')
const WIDTH = 1440
const HEIGHT = 900

/** A fixed window size and the dark theme, so every shot has the same frame. */
async function frame(electronApp: ElectronApplication, page: Page): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(width, height)
      win.center()
    },
    { width: WIDTH, height: HEIGHT }
  )
  await page.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {})
  await new Shell(page).themeButton('Dark').click()
}

/** Lets animations and late layout settle, then saves the window as `<name>.png` at 1x. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, HEIGHT - 1)
  await page.waitForTimeout(800)
  await mkdir(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, `${name}.png`), scale: 'css', animations: 'disabled' })
}

/**
 * The in-app browser's tabs are native `WebContentsView`s that a renderer
 * screenshot does not include: capture the window and the visible tab in the
 * main process and draw the tab over its bounds on a canvas in the renderer.
 */
async function shootWithTab(electronApp: ElectronApplication, page: Page, name: string): Promise<void> {
  await page.mouse.move(0, HEIGHT - 1)
  await page.waitForTimeout(1200)
  const shots = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const views = win.contentView.children.filter((v) => v.getVisible())
    const view = views[views.length - 1] as Electron.WebContentsView
    const bounds = view.getBounds()
    const [base, tab] = await Promise.all([win.webContents.capturePage(), view.webContents.capturePage()])
    return { base: base.toDataURL(), tab: tab.toDataURL(), bounds }
  })
  const png = await page.evaluate(
    async ({ base, tab, bounds, width, height }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((done, fail) => {
          const img = new Image()
          img.onload = () => done(img)
          img.onerror = fail
          img.src = src
        })
      const [b, t] = await Promise.all([load(base), load(tab)])
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(b, 0, 0, width, height)
      ctx.drawImage(t, bounds.x, bounds.y, bounds.width, bounds.height)
      return canvas.toDataURL('image/png').split(',')[1]
    },
    { ...shots, width: WIDTH, height: HEIGHT }
  )
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, `${name}.png`), Buffer.from(png, 'base64'))
}

test.describe('demo workspace', () => {
  test.use({ workspace: 'demo', prepare: withFakeAgents({ script: 'slow', slowMs: 150 }) })

  test('dashboard, board and tailor', async ({ app }) => {
    const page = app.window
    const shell = new Shell(page)
    await shell.expectVisible()
    await frame(app.electronApp, page)

    await shell.expectActive('dashboard')
    await expect(page.getByRole('row').filter({ hasText: 'Initech' }).first()).toBeVisible()
    await shoot(page, 'dashboard')

    await shell.goTo('board')
    await expect(new BoardPage(page).cards('interviewing').first()).toBeVisible()
    await shoot(page, 'board')

    await shell.goTo('tailor')
    const tailor = new TailorPage(page)
    await tailor.start({
      description:
        '# Staff Platform Engineer\n\nAcme Corp is hiring a Staff Platform Engineer to lead its developer platform: Go, PostgreSQL, AWS, Terraform and Kubernetes.',
      company: 'Acme Corp',
      role: 'Staff Platform Engineer'
    })
    await expect(tailor.runTitle('Staff Platform Engineer · Acme Corp')).toBeVisible({ timeout: 30_000 })
    await tailor.expectStatus('Finished', 30_000)
    // The page scrolls to the newest message; bring its heading back into the frame.
    await tailor.heading.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await shoot(page, 'tailor')
  })
})

test.describe('mocks workspace', () => {
  test.use({ workspace: 'mocks' })

  test('apply in the in-app browser', async ({ app, mock }) => {
    const page = app.window
    const shell = new Shell(page)
    await shell.expectVisible()
    await frame(app.electronApp, page)
    await shell.expectActive('dashboard')
    await page.getByRole('row').filter({ hasText: 'Lever Mock' }).getByRole('button', { name: 'Apply', exact: true }).click()
    await shell.expectActive('browser')
    const browser = new BrowserPage(page)
    await expectTabLoaded(app.electronApp, `${mock.origin.replace('http://', '')}/lever/`)
    await browser.apply.expectStatus('Filled: review and submit')
    await shootWithTab(app.electronApp, page, 'apply')
  })
})
