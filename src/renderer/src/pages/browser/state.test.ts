import { describe, expect, it } from 'vitest'
import type { BrowserTab } from '@shared/browser-types'
import { activeTab, displayUrl, EMPTY_STATE, findTab, isSecure, modKey, tabLabel } from './state'

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

  it('shows ⌘ on macOS and Ctrl+ elsewhere in the shortcut hints', () => {
    expect(modKey('MacIntel')).toBe('⌘')
    expect(modKey('Linux x86_64')).toBe('Ctrl+')
    expect(modKey('Win32')).toBe('Ctrl+')
  })

  it('shows the lock for HTTPS pages only', () => {
    expect(isSecure(tab('tab-1', 'https://a.example/'))).toBe(true)
    expect(isSecure(tab('tab-1', 'http://127.0.0.1:3000/'))).toBe(false)
    expect(isSecure(tab('tab-1', 'about:blank'))).toBe(false)
    expect(isSecure(null)).toBe(false)
  })

  it('shows no lock while an HTTPS page is loading or after it failed to load', () => {
    expect(isSecure({ ...tab('tab-1', 'https://a.example/'), loading: true })).toBe(false)
    expect(isSecure({ ...tab('tab-1', 'https://a.example/'), error: 'Could not load a.example' })).toBe(false)
  })
})
