import { expect, type Locator, type Page } from '@playwright/test'

/** Navbar entries in order, with the label of each and how its page announces itself. */
export const SHELL_PAGES = {
  dashboard: { label: 'Dashboard', heading: 'Dashboard' },
  jobs: { label: 'Jobs', heading: 'Jobs' },
  browser: { label: 'Browser', heading: null },
  tailor: { label: 'Tailor', heading: 'Tailor' },
  graph: { label: 'Knowledge graph', heading: 'Knowledge graph' },
  profile: { label: 'Master profile', heading: null },
  settings: { label: 'Settings', heading: 'Settings' }
} as const

export type ShellPage = keyof typeof SHELL_PAGES

/** The app shell once a workspace is open: navbar, page heading, workspace switch. */
export class Shell {
  readonly navbar: Locator
  readonly switchWorkspaceButton: Locator

  constructor(readonly page: Page) {
    this.navbar = page.getByRole('navigation')
    this.switchWorkspaceButton = page.getByRole('button', { name: 'Switch workspace' })
  }

  /** A navbar entry (a Mantine NavLink: a button named by its label and hint). */
  navLink(name: ShellPage): Locator {
    return this.navbar.getByRole('button', { name: new RegExp(`^${SHELL_PAGES[name].label}\\b`) })
  }

  async expectVisible(workspacePath?: string): Promise<void> {
    await expect(this.navbar).toBeVisible()
    await expect(this.switchWorkspaceButton).toBeVisible()
    if (workspacePath) await expect(this.navbar.getByText(workspacePath, { exact: true })).toBeVisible()
  }

  /** Opens a page from the navbar and waits until it is the active one. */
  async goTo(name: ShellPage): Promise<void> {
    await this.navLink(name).click()
    await this.expectActive(name)
  }

  /** Entries currently marked as the current page (`aria-current="page"`); exactly one while a page is open. */
  get currentEntries(): Locator {
    return this.navbar.getByRole('button').and(this.navbar.locator('[aria-current="page"]'))
  }

  /** `name` is the current page (`aria-current="page"`, Mantine's active state) and its heading (when it has one) is shown. */
  async expectActive(name: ShellPage): Promise<void> {
    await expect(this.navLink(name)).toHaveAttribute('aria-current', 'page')
    await expect(this.navLink(name)).toHaveAttribute('data-active', 'true')
    await expect(this.currentEntries).toHaveCount(1)
    const { heading } = SHELL_PAGES[name]
    if (heading) await expect(this.page.getByRole('heading', { name: heading, level: 2 })).toBeVisible()
  }
}
