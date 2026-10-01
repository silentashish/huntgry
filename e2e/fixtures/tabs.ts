import type { ElectronApplication } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * The in-app browser's tabs are `WebContentsView`s owned by the main
 * process, children of the main window's `contentView`. Playwright also
 * exposes each loaded tab as a `Page` (`electronApp.windows()`), but tab
 * state (URL, title, loading) and the Submit press are read and driven here
 * from the main process through `electronApp.evaluate`, which does not
 * depend on when Playwright attaches to the tab (see docs/testing/e2e.md).
 */

export interface TabInfo {
  url: string
  title: string
  loading: boolean
}

/** Every tab, in the order they were opened. */
export function listTabs(electronApp: ElectronApplication): Promise<TabInfo[]> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.contentView)
    if (!win) return []
    return win.contentView.children.map((view) => {
      const wc = (view as Electron.WebContentsView).webContents
      return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() }
    })
  })
}

/** Waits until a tab whose URL contains `urlPart` exists and returns it. */
export async function tabWithUrl(electronApp: ElectronApplication, urlPart: string): Promise<TabInfo> {
  await expect.poll(async () => (await listTabs(electronApp)).some((t) => t.url.includes(urlPart)), {
    message: `a tab with "${urlPart}" in its URL`
  }).toBe(true)
  return (await listTabs(electronApp)).find((t) => t.url.includes(urlPart))!
}

/** Waits until the tab with `urlPart` has finished loading and its title is `title`. */
export async function expectTabLoaded(electronApp: ElectronApplication, urlPart: string, title?: string): Promise<void> {
  await expect
    .poll(async () => {
      const tab = (await listTabs(electronApp)).find((t) => t.url.includes(urlPart))
      return tab && !tab.loading ? tab.title : null
    }, { message: `the tab with "${urlPart}" loaded${title ? ` with title "${title}"` : ''}` })
    .toEqual(title ?? expect.any(String))
}

/**
 * Runs `script` (an expression) in the page of the tab whose URL contains
 * `urlPart` and returns its value. This is how a test presses a mock ATS's own
 * Submit button: the app never does.
 */
export function evaluateInTab<T>(electronApp: ElectronApplication, urlPart: string, script: string): Promise<T> {
  return electronApp.evaluate(
    async ({ BrowserWindow }, { urlPart, script }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.contentView)
      const view = win?.contentView.children.find((v) => (v as Electron.WebContentsView).webContents.getURL().includes(urlPart))
      if (!view) throw new Error(`No tab with "${urlPart}" in its URL`)
      return (await (view as Electron.WebContentsView).webContents.executeJavaScript(script, true)) as T
    },
    { urlPart, script }
  )
}

/** Fills `values` (selector → value, checkboxes with `true`) in the tab's form and clicks its submit button. */
export async function pressSubmitInTab(
  electronApp: ElectronApplication,
  urlPart: string,
  values: Record<string, string | true> = {}
): Promise<void> {
  const script = `(() => {
    const values = ${JSON.stringify(values)};
    for (const [selector, value] of Object.entries(values)) {
      const el = document.querySelector(selector);
      if (!el) throw new Error('No element ' + selector);
      if (value === true) el.checked = true; else el.value = value;
    }
    const button = document.querySelector('button[type="submit"], input[type="submit"]');
    if (!button) throw new Error('No submit button');
    button.click();
    return true;
  })()`
  await evaluateInTab<boolean>(electronApp, urlPart, script)
}

/**
 * Replaces `shell.openExternal` in the main process with a recorder and
 * returns a reader of the URLs handed to it, so "Open in browser" never
 * reaches the system browser during a test.
 */
export async function stubOpenExternal(electronApp: ElectronApplication): Promise<() => Promise<string[]>> {
  await electronApp.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __huntgryOpened?: string[] }).__huntgryOpened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  return () => electronApp.evaluate(() => (globalThis as { __huntgryOpened?: string[] }).__huntgryOpened ?? [])
}
