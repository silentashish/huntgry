import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closeApp, createSandbox, destroySandbox, launchApp } from '../fixtures/app'
import { expect, test } from '../fixtures/servers/fixture'
import { evaluateInTab, expectTabLoaded, listTabs, stubOpenExternal, tabWithUrl } from '../fixtures/tabs'
import { rememberWorkspace, seedWorkspace } from '../fixtures/workspace'
import { BrowserPage } from '../pages/browser'
import { JobsPage } from '../pages/jobs'
import { Shell } from '../pages/shell'

/**
 * The embedded browser against the mock server on 127.0.0.1. Tabs are
 * `WebContentsView`s owned by main, so their URL, title and DOM are read
 * through `electronApp.evaluate` (fixtures/tabs.ts); the tab strip, toolbar
 * and notices are ordinary DOM.
 */
test.use({ workspace: 'mocks' })

test.describe('browser tabs', () => {
  test('"Open posting" on a job opens a tab with the posting, and the tab survives leaving the page', async ({ app, mock }) => {
    const shell = new Shell(app.window)
    await shell.goTo('jobs')
    const jobs = new JobsPage(app.window)
    await jobs.openJob('Infrastructure Engineer')
    await jobs.drawerButton('Open posting').click()

    await shell.expectActive('browser')
    const browser = new BrowserPage(app.window)
    const url = `${mock.origin}/postings/employer/103`
    await expect(browser.address).toHaveValue(url)
    await expectTabLoaded(app.electronApp, '/postings/employer/103', 'Infrastructure Engineer – Tyrell Robotics')
    await expect(browser.tab('Infrastructure Engineer – Tyrell Robotics')).toBeVisible()
    // The tab is a WebContentsView owned by main; its DOM is reachable through the main process…
    expect(await evaluateInTab<string>(app.electronApp, '/postings/employer/103', 'document.querySelector("h1").textContent')).toBe(
      'Infrastructure Engineer'
    )
    // …and Playwright also lists it as a second Page next to the app window (see docs/testing/e2e.md).
    await expect.poll(() => app.electronApp.windows().map((w) => w.url())).toEqual([expect.stringMatching(/^file:/), url])
    const tabPage = app.electronApp.windows().find((w) => w.url() === url)!
    await expect(tabPage.getByRole('heading', { name: 'Infrastructure Engineer' })).toBeVisible()
    // The request reached the mock server, and only it.
    expect(mock.requests).toContain('/postings/employer/103')

    // Leaving for another page and coming back keeps the tab.
    await shell.goTo('dashboard')
    await shell.goTo('browser')
    await expect(browser.tab('Infrastructure Engineer – Tyrell Robotics')).toBeVisible()
    await expect(browser.address).toHaveValue(url)
    expect((await listTabs(app.electronApp)).map((t) => t.url)).toEqual([url])
  })

  test('back, forward, reload and stop follow the page', async ({ app, mock }) => {
    const shell = new Shell(app.window)
    await shell.goTo('browser')
    const browser = new BrowserPage(app.window)
    await expect(browser.emptyState).toBeVisible()
    await browser.go(`${mock.origin}/page/one`)
    await expectTabLoaded(app.electronApp, '/page/one', 'Mock page one')
    await expect(browser.backButton).toBeDisabled()
    await expect(browser.forwardButton).toBeDisabled()

    // A link inside the page: history grows, Back becomes possible.
    await evaluateInTab(app.electronApp, '/page/one', 'document.getElementById("next").click()')
    await expectTabLoaded(app.electronApp, '/page/two', 'Mock page two')
    await expect(browser.address).toHaveValue(`${mock.origin}/page/two`)
    await expect(browser.backButton).toBeEnabled()
    await expect(browser.forwardButton).toBeDisabled()

    await browser.backButton.click()
    await expectTabLoaded(app.electronApp, '/page/one', 'Mock page one')
    await expect(browser.address).toHaveValue(`${mock.origin}/page/one`)
    await expect(browser.forwardButton).toBeEnabled()
    await browser.forwardButton.click()
    await expectTabLoaded(app.electronApp, '/page/two', 'Mock page two')

    // Reload asks the server again.
    const before = mock.requests.filter((r) => r === '/page/two').length
    await browser.reloadButton.click()
    await expect.poll(() => mock.requests.filter((r) => r === '/page/two').length).toBe(before + 1)

    // A page that never finishes loading: Stop replaces Reload until pressed.
    await browser.go(`${mock.origin}/hang`)
    await expect(browser.stopButton).toBeVisible()
    await browser.stopButton.click()
    await expect(browser.reloadButton).toBeVisible()
    await expect(browser.stopButton).toHaveCount(0)
    await expect.poll(async () => (await tabWithUrl(app.electronApp, '/hang')).loading).toBe(false)
  })

  test('the address bar completes a bare host with https and refuses other schemes, private addresses and non-URLs', async ({ app, mock }) => {
    const shell = new Shell(app.window)
    await shell.goTo('browser')
    const browser = new BrowserPage(app.window)

    // A bare host gets https:// (the mock speaks plain http, so the load itself fails; the address is what is under test).
    await browser.go(`localhost:${mock.port}/page/one`)
    await expect(browser.address).toHaveValue(`https://localhost:${mock.port}/page/one`)
    await browser.expectNotice(`Could not load localhost:${mock.port}`)

    // Every refusal leaves the tab where it was: the exact messages come from src/main/browser/url.ts.
    const cases: Array<[string, string]> = [
      ['javascript:alert(1)', 'Only http:// and https:// addresses can be opened.'],
      ['file:///etc/hosts', 'Only http:// and https:// addresses can be opened.'],
      ['data:text/html,hi', 'Only http:// and https:// addresses can be opened.'],
      ['not a url', 'Enter a URL, e.g. jobs.example.com/posting.'],
      ['http://10.0.0.1/', 'Refusing to load 10.0.0.1: it is a local or private-network address.'],
      ['192.168.1.1/admin', 'Refusing to load 192.168.1.1: it is a local or private-network address.'],
      ['http://169.254.169.254/latest/meta-data', 'Refusing to load 169.254.169.254: it is a local or private-network address.'],
      ['http://intranet.local/', 'Refusing to load intranet.local: it is a local or private-network address.']
    ]
    for (const [input, message] of cases) {
      await browser.go(input)
      await browser.expectNotice(message)
      // The text stays in the address bar for correction; the tab did not move.
      await expect(browser.address).toHaveValue(input)
    }
    expect((await listTabs(app.electronApp)).map((t) => t.url)).toEqual([`https://localhost:${mock.port}/page/one`])
    // A public name goes through the guard's lookup and never loads a page here: nothing but 127.0.0.1 is reached.
    await browser.go('https://jobs.example.invalid/posting')
    await browser.expectNotice('Could not find jobs.example.invalid.')
    expect(mock.requests.filter((r) => r.startsWith('/page/one'))).toHaveLength(0)
  })

  test('Cmd/Ctrl+T opens a tab, Cmd/Ctrl+L focuses the address bar, the close button closes a tab', async ({ app, mock }) => {
    const shell = new Shell(app.window)
    await shell.goTo('browser')
    const browser = new BrowserPage(app.window)
    await browser.go(`${mock.origin}/page/one`)
    await expectTabLoaded(app.electronApp, '/page/one', 'Mock page one')

    await app.window.keyboard.press('ControlOrMeta+t')
    await expect(browser.tab('New tab')).toBeVisible()
    await expect(browser.address).toBeFocused()
    await expect(browser.address).toHaveValue('')
    expect(await listTabs(app.electronApp)).toHaveLength(2)

    await browser.address.blur()
    await expect(browser.address).not.toBeFocused()
    await app.window.keyboard.press('ControlOrMeta+l')
    await expect(browser.address).toBeFocused()

    await browser.closeTab('New tab').click()
    await expect(browser.tab('New tab')).toHaveCount(0)
    await expect(browser.tab('Mock page one')).toBeVisible()
    await browser.closeTab('Mock page one').click()
    await expect(browser.emptyState).toBeVisible()
    await expect.poll(() => listTabs(app.electronApp)).toEqual([])
  })

  test('"Open in browser" hands the tab URL to shell.openExternal', async ({ app, mock }) => {
    const shell = new Shell(app.window)
    await shell.goTo('browser')
    const browser = new BrowserPage(app.window)
    await expect(browser.openInBrowserButton).toBeDisabled()
    await browser.go(`${mock.origin}/page/two`)
    await expectTabLoaded(app.electronApp, '/page/two', 'Mock page two')

    const opened = await stubOpenExternal(app.electronApp)
    await browser.openInBrowserButton.click()
    await expect.poll(opened).toEqual([`${mock.origin}/page/two`])
  })
})

test.describe('loopback allowance', () => {
  test('without HUNTGRY_ALLOW_LOCAL_URLS the mock server is refused like any local address', async ({ mock }) => {
    // The guard is what keeps the app off the local network; the harness only lifts it for loopback, explicitly.
    const sandbox = await createSandbox()
    let launched: Awaited<ReturnType<typeof launchApp>> | null = null
    try {
      const workspace = await seedWorkspace('mocks', sandbox.workspaces)
      await rememberWorkspace(sandbox.userData, workspace)
      launched = await launchApp(sandbox, { HUNTGRY_ALLOW_LOCAL_URLS: '0' })
      const shell = new Shell(launched.window)
      await shell.goTo('browser')
      const browser = new BrowserPage(launched.window)
      await browser.go(`${mock.origin}/page/one`)
      await browser.expectNotice(`Refusing to load 127.0.0.1:${mock.port}: it is a local or private-network address.`)
      expect(await listTabs(launched.electronApp)).toEqual([])
      expect(mock.requests).toEqual([])
      // The saved settings prove the app ran in this sandbox, not anywhere else.
      expect(JSON.parse(await readFile(join(sandbox.userData, 'settings.json'), 'utf8')).currentWorkspace).toBe(workspace)
    } finally {
      if (launched) await closeApp(launched.electronApp)
      await destroySandbox(sandbox)
    }
  })
})
