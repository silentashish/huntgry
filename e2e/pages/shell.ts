import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Sidebar entries in order, with the label of each and how its page announces itself. 10 entries: the
 * Knowledge graph is a view of Profile (#108), opened with `Shell.openGraph()`; Explore follows Jobs (#142);
 * Automation follows Review (#154).
 */
export const SHELL_PAGES = {
  dashboard: { label: 'Dashboard', heading: 'Dashboard' },
  board: { label: 'Board', heading: 'Board' },
  jobs: { label: 'Jobs', heading: 'Jobs' },
  explore: { label: 'Explore', heading: 'Explore' },
  browser: { label: 'Browser', heading: null },
  tailor: { label: 'Tailor', heading: 'Tailor' },
  review: { label: 'Review', heading: null },
  automation: { label: 'Automation', heading: 'Automation' },
  profile: { label: 'Profile', heading: null },
  settings: { label: 'Settings', heading: 'Settings' }
} as const

export type ShellPage = keyof typeof SHELL_PAGES

/** The app shell once a workspace is open: sidebar, page heading, workspace switch, ⌘K palette. */
export class Shell {
  readonly navbar: Locator
  readonly switchWorkspaceButton: Locator
  /** "Sniff anything… ⌘K" in the sidebar. */
  readonly searchButton: Locator
  /** The command palette ("Sniff"), its search box and its result list. */
  readonly palette: Locator
  readonly paletteInput: Locator
  readonly paletteResults: Locator
  /** "Buy me a coffee" at the bottom of the sidebar (#185), and its occasional "Enjoying Huntgry?" bubble. */
  readonly coffeeLink: Locator
  readonly coffeeBubble: Locator

  constructor(readonly page: Page) {
    this.navbar = page.getByRole('navigation')
    this.switchWorkspaceButton = page.getByRole('button', { name: 'Switch workspace' })
    this.searchButton = this.navbar.getByRole('button', { name: /^Sniff anything/ })
    this.palette = page.getByRole('dialog', { name: 'Sniff' })
    this.paletteInput = this.palette.getByRole('combobox', { name: 'Sniff anything' })
    this.paletteResults = this.palette.getByRole('listbox', { name: 'Results' })
    this.coffeeLink = this.navbar.getByRole('link', { name: /^Buy me a coffee/ })
    this.coffeeBubble = this.navbar.getByRole('status').filter({ hasText: 'Enjoying Huntgry?' })
  }

  /** A sidebar entry: a button named by its label (then the count badge's text, if any). */
  navLink(name: ShellPage): Locator {
    return this.navbar.getByRole('button', { name: new RegExp(`^${SHELL_PAGES[name].label}\\b`) })
  }

  /** A theme toggle option at the bottom of the sidebar. */
  themeButton(name: 'System' | 'Light' | 'Dark'): Locator {
    return this.navbar.getByRole('button', { name: `${name} theme` })
  }

  async expectVisible(workspacePath?: string): Promise<void> {
    await expect(this.navbar).toBeVisible()
    await expect(this.switchWorkspaceButton).toBeVisible()
    if (workspacePath) await expect(this.navbar.getByText(workspacePath, { exact: true })).toBeVisible()
  }

  /** Opens a page from the sidebar and waits until it is the active one. */
  async goTo(name: ShellPage): Promise<void> {
    await this.navLink(name).click()
    await this.expectActive(name)
  }

  /** Entries currently marked as the current page (`aria-current="page"`); exactly one while a page is open. */
  get currentEntries(): Locator {
    return this.navbar.getByRole('button').and(this.navbar.locator('[aria-current="page"]'))
  }

  /** `name` is the current page (`aria-current="page"`, the ember active state) and its heading (when it has one) is shown. */
  async expectActive(name: ShellPage): Promise<void> {
    await expect(this.navLink(name)).toHaveAttribute('aria-current', 'page')
    await expect(this.navLink(name)).toHaveAttribute('data-active', 'true')
    await expect(this.currentEntries).toHaveCount(1)
    const { heading } = SHELL_PAGES[name]
    if (heading) await expect(this.page.getByRole('heading', { name: heading, level: 2 })).toBeVisible()
  }

  /** Opens the palette with ⌘K / Ctrl+K (or the sidebar button) and waits for its search box to have focus. */
  async openPalette(via: 'keyboard' | 'button' = 'keyboard'): Promise<void> {
    // The shortcut is listened for once the shell is up.
    await expect(this.searchButton).toBeVisible()
    if (via === 'keyboard') await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    else await this.searchButton.click()
    await expect(this.palette).toBeVisible()
    await expect(this.paletteInput).toBeFocused()
  }

  /** An entry of the palette's results. */
  paletteOption(name: string | RegExp): Locator {
    return this.paletteResults.getByRole('option', { name: typeof name === 'string' ? name : name, exact: typeof name === 'string' })
  }

  /** A result group by its heading (`Jobs · 2`, `Go to`). */
  paletteGroup(label: string | RegExp): Locator {
    return this.paletteResults.getByRole('group', { name: label })
  }

  /** Types `query` into the palette and chooses `option` with the mouse. */
  async sniff(query: string, option: string | RegExp): Promise<void> {
    await this.openPalette()
    await this.paletteInput.fill(query)
    await this.paletteOption(option).click()
    await expect(this.palette).toBeHidden()
  }

  /**
   * The Knowledge graph view of Profile (the old `graph` page), through the palette: Profile is the current
   * entry, its view switch is on Knowledge graph and the graph's "Jump to…" node picker is shown.
   */
  async openGraph(): Promise<void> {
    await this.sniff('knowledge graph', 'Profile → Knowledge graph')
    await this.expectActive('profile')
    const views = this.page.getByRole('radiogroup', { name: 'Profile view' })
    await expect(views.getByRole('radio', { name: 'Knowledge graph', exact: true })).toBeChecked()
    await expect(this.page.getByRole('combobox', { name: 'Select a node of the graph' })).toBeVisible()
  }
}
