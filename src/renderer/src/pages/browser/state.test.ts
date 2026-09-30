import { describe, expect, it } from 'vitest'
import type { BrowserTab } from '@shared/browser-types'
import { activeTab, displayUrl, EMPTY_STATE, findTab, tabLabel } from './state'

const tab = (id: string, url: string, title = ''): BrowserTab => ({
  id,
  url,
  title,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
})

describe('browser page state', () => {
  it('finds the active tab', () => {
    expect(activeTab(EMPTY_STATE)).toBeNull()
    const state = { tabs: [tab('tab-1', 'https://a.example/'), tab('tab-2', 'https://b.example/')], activeId: 'tab-2' }
    expect(activeTab(state)?.id).toBe('tab-2')
  })

  it('shows an empty address for a blank tab', () => {
    expect(displayUrl(tab('tab-1', 'about:blank'))).toBe('')
    expect(displayUrl(null)).toBe('')
    expect(displayUrl(tab('tab-1', 'https://a.example/x'))).toBe('https://a.example/x')
  })

  it('labels tabs by title, then host, then "New tab"', () => {
    expect(tabLabel(tab('tab-1', 'https://a.example/x', ' Staff Engineer '))).toBe('Staff Engineer')
    expect(tabLabel(tab('tab-1', 'https://a.example/x'))).toBe('a.example')
    expect(tabLabel(tab('tab-1', 'https://a.example/x', 'https://a.example/x'))).toBe('a.example')
    expect(tabLabel(tab('tab-1', 'about:blank'))).toBe('New tab')
  })

  it('finds a tab already showing a posting', () => {
    const state = { tabs: [tab('tab-1', 'https://jobs.example.com/1/'), tab('tab-2', 'https://b.example/')], activeId: 'tab-1' }
    expect(findTab(state, 'https://jobs.example.com/1')?.id).toBe('tab-1')
    expect(findTab(state, 'https://jobs.example.com/1#apply')?.id).toBe('tab-1')
    expect(findTab(state, 'https://jobs.example.com/2')).toBeNull()
  })
})
