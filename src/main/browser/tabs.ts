import { MAX_TABS, type BrowserState, type BrowserTab } from '@shared/browser-types'

/**
 * Tab order, the active tab and each tab's display state. Pure data: the
 * manager keeps the Chromium views next to it and patches tabs from their
 * events, so this is unit-tested without Electron.
 */
export class TabRegistry {
  private tabs: BrowserTab[] = []
  private activeId: string | null = null
  private next = 1

  constructor(private readonly maxTabs = MAX_TABS) {}

  /** Adds a tab after the others; throws at the cap. */
  open(url: string, activate = true): BrowserTab {
    if (this.tabs.length >= this.maxTabs) {
      throw new Error(`At most ${this.maxTabs} tabs can be open; close one first.`)
    }
    const tab: BrowserTab = {
      id: `tab-${this.next++}`,
      url,
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null
    }
    this.tabs.push(tab)
    if (activate || this.activeId === null) this.activeId = tab.id
    return { ...tab }
  }

  has(id: string): boolean {
    return this.tabs.some((t) => t.id === id)
  }

  get(id: string): BrowserTab | undefined {
    const tab = this.tabs.find((t) => t.id === id)
    return tab ? { ...tab } : undefined
  }

  get active(): string | null {
    return this.activeId
  }

  /** Removes a tab; when it was active, the tab to its right (else left) becomes active. */
  close(id: string): boolean {
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index < 0) return false
    this.tabs.splice(index, 1)
    if (this.activeId === id) {
      this.activeId = (this.tabs[index] ?? this.tabs[index - 1])?.id ?? null
    }
    return true
  }

  activate(id: string): boolean {
    if (!this.has(id)) return false
    this.activeId = id
    return true
  }

  /** Updates a tab's display state; unknown ids are ignored (a view may report after its tab closed). */
  patch(id: string, changes: Partial<Omit<BrowserTab, 'id'>>): boolean {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return false
    Object.assign(tab, changes)
    return true
  }

  ids(): string[] {
    return this.tabs.map((t) => t.id)
  }

  /** A copy of the state, safe to send to the renderer. */
  snapshot(): BrowserState {
    return { tabs: this.tabs.map((t) => ({ ...t })), activeId: this.activeId }
  }
}
