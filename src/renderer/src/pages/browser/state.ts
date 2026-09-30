import type { BrowserState, BrowserTab } from '@shared/browser-types'

/** Display helpers for the Browser page (pure, unit-tested). */

export const EMPTY_STATE: BrowserState = { tabs: [], activeId: null }

export function activeTab(state: BrowserState): BrowserTab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null
}

/** What the address bar shows: nothing for an empty tab. */
export function displayUrl(tab: BrowserTab | null): string {
  if (!tab || tab.url === 'about:blank') return ''
  return tab.url
}

/** Tab strip label: the page title, else its host, else "New tab". */
export function tabLabel(tab: BrowserTab): string {
  if (tab.title.trim() && tab.title !== tab.url) return tab.title.trim()
  if (tab.url === 'about:blank') return 'New tab'
  try {
    return new URL(tab.url).host || tab.url
  } catch {
    return tab.url
  }
}

/** A tab already showing `url` (ignoring a trailing slash or `#fragment`), so a posting is not opened twice. */
export function findTab(state: BrowserState, url: string): BrowserTab | null {
  const key = (u: string) => {
    try {
      const parsed = new URL(u)
      parsed.hash = ''
      return parsed.href.replace(/\/$/, '')
    } catch {
      return u.trim()
    }
  }
  const wanted = key(url)
  return state.tabs.find((t) => key(t.url) === wanted) ?? null
}
