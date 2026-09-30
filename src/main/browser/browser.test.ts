import { describe, expect, it } from 'vitest'
import { MAX_URL_LENGTH } from '@shared/browser-types'
import { TabRegistry } from './tabs'
import { isAllowedNavigation, loadErrorMessage, normalizeAddress } from './url'
import { requireRect, requireTabId, requireText } from './validate'

describe('normalizeAddress', () => {
  it('keeps http(s) URLs and adds https:// to bare hosts', () => {
    expect(normalizeAddress('https://jobs.ashbyhq.com/acme/1')).toEqual({ ok: true, url: 'https://jobs.ashbyhq.com/acme/1' })
    expect(normalizeAddress('  http://example.com ')).toEqual({ ok: true, url: 'http://example.com/' })
    expect(normalizeAddress('jobs.ashbyhq.com/acme')).toEqual({ ok: true, url: 'https://jobs.ashbyhq.com/acme' })
    expect(normalizeAddress('boards.greenhouse.io:443/x')).toEqual({ ok: true, url: 'https://boards.greenhouse.io/x' })
    expect(normalizeAddress('about:blank')).toEqual({ ok: true, url: 'about:blank' })
  })

  it('refuses other schemes, search text, empty and oversized input', () => {
    for (const input of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<b>x</b>',
      'chrome://settings',
      'view-source:https://example.com',
      'mailto:a@example.com',
      'senior engineer jobs',
      'nodots',
      '',
      '   ',
      `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`
    ]) {
      expect(normalizeAddress(input).ok, input).toBe(false)
    }
  })
})

describe('isAllowedNavigation', () => {
  it('allows http(s) and about:blank only', () => {
    expect(isAllowedNavigation('https://example.com/')).toBe(true)
    expect(isAllowedNavigation('http://example.com/')).toBe(true)
    expect(isAllowedNavigation('about:blank')).toBe(true)
    expect(isAllowedNavigation('file:///etc/passwd')).toBe(false)
    expect(isAllowedNavigation('javascript:alert(1)')).toBe(false)
    expect(isAllowedNavigation('data:text/html,x')).toBe(false)
    expect(isAllowedNavigation('chrome://gpu')).toBe(false)
    expect(isAllowedNavigation('not a url')).toBe(false)
  })
})

describe('loadErrorMessage', () => {
  it('ignores aborted loads and explains blocked ones', () => {
    expect(loadErrorMessage(-3, 'ERR_ABORTED', 'https://a.example/')).toBeNull()
    expect(loadErrorMessage(-20, 'ERR_BLOCKED_BY_CLIENT', 'http://127.0.0.1:8080/')).toMatch(/127\.0\.0\.1:8080.*private/)
    expect(loadErrorMessage(-105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.example/')).toBe(
      'Could not load nope.example (ERR_NAME_NOT_RESOLVED).'
    )
  })
})

describe('TabRegistry', () => {
  it('opens tabs in order with generated ids and activates them', () => {
    const r = new TabRegistry()
    const a = r.open('https://a.example/')
    const b = r.open('https://b.example/')
    expect([a.id, b.id]).toEqual(['tab-1', 'tab-2'])
    expect(r.snapshot().activeId).toBe('tab-2')
    r.open('https://c.example/', false)
    expect(r.snapshot().activeId).toBe('tab-2')
    expect(r.ids()).toEqual(['tab-1', 'tab-2', 'tab-3'])
  })

  it('activates the first tab even when asked not to', () => {
    const r = new TabRegistry()
    r.open('https://a.example/', false)
    expect(r.active).toBe('tab-1')
  })

  it('enforces the tab cap', () => {
    const r = new TabRegistry(2)
    r.open('about:blank')
    r.open('about:blank')
    expect(() => r.open('about:blank')).toThrow(/At most 2 tabs/)
  })

  it('closing the active tab activates the right neighbour, then the left, then none', () => {
    const r = new TabRegistry()
    r.open('a')
    r.open('b')
    r.open('c')
    r.activate('tab-2')
    r.close('tab-2')
    expect(r.active).toBe('tab-3')
    r.close('tab-3')
    expect(r.active).toBe('tab-1')
    r.close('tab-1')
    expect(r.active).toBeNull()
    expect(r.close('tab-1')).toBe(false)
  })

  it('closing an inactive tab keeps the active one', () => {
    const r = new TabRegistry()
    r.open('a')
    r.open('b')
    r.close('tab-1')
    expect(r.active).toBe('tab-2')
  })

  it('patches known tabs, ignores unknown ones and hands out copies', () => {
    const r = new TabRegistry()
    r.open('a')
    expect(r.patch('tab-1', { title: 'A', loading: true })).toBe(true)
    expect(r.patch('tab-9', { title: 'X' })).toBe(false)
    expect(r.activate('tab-9')).toBe(false)
    const snap = r.snapshot()
    expect(snap.tabs[0]).toMatchObject({ title: 'A', loading: true })
    snap.tabs[0].title = 'changed'
    expect(r.get('tab-1')?.title).toBe('A')
  })
})

describe('IPC input checks', () => {
  it('accepts main-generated tab ids only', () => {
    expect(requireTabId('tab-12')).toBe('tab-12')
    for (const bad of ['tab-', 'tab-1234567', 'webContents-3', 7, null, 'tab-1; x']) {
      expect(() => requireTabId(bad)).toThrow('Invalid tab id.')
    }
  })

  it('limits URL text length and type', () => {
    expect(requireText('example.com')).toBe('example.com')
    expect(() => requireText('a'.repeat(MAX_URL_LENGTH + 1))).toThrow()
    expect(() => requireText({ url: 'x' })).toThrow()
  })

  it('rounds rectangles and refuses negative, infinite or missing values', () => {
    expect(requireRect({ x: 240.4, y: 96.6, width: 900, height: 600 })).toEqual({ x: 240, y: 97, width: 900, height: 600 })
    for (const bad of [
      { x: -1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: Infinity, height: 1 },
      { x: 0, y: 0, width: Number.NaN, height: 1 },
      { x: 0, y: 0, width: '10', height: 1 },
      { x: 0, y: 0, width: 1 },
      null
    ]) {
      expect(() => requireRect(bad)).toThrow('Invalid bounds.')
    }
  })
})
