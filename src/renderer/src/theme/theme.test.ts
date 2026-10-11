import { describe, expect, it } from 'vitest'
import { mergeMantineTheme, DEFAULT_THEME } from '@mantine/core'
import { cssVariablesResolver, theme, toneOf, variantColorResolver } from './theme'
import { preferenceOf, schemeOf, THEME_PREFERENCES } from './useThemePreference'

const full = mergeMantineTheme(DEFAULT_THEME, theme)

describe('Scent Trail theme', () => {
  it('uses Ember as the primary colour and the bundled fonts', () => {
    expect(full.primaryColor).toBe('ember')
    expect(full.fontFamily).toContain('Geist Variable')
    expect(full.fontFamilyMonospace).toContain('Geist Mono Variable')
    expect(full.headings.fontFamily).toContain('Bricolage Grotesque Variable')
    for (const name of ['ember', 'trail', 'success', 'warning', 'danger', 'info', 'review', 'dark', 'gray']) {
      expect(full.colors[name]).toHaveLength(10)
    }
  })

  it('points Mantine colour variables at the tokens in both schemes', () => {
    const vars = cssVariablesResolver(full)
    for (const scheme of [vars.light, vars.dark]) {
      expect(scheme['--mantine-color-body']).toBe('var(--hg-bg-canvas)')
      expect(scheme['--mantine-color-red-filled']).toBe('var(--hg-status-danger)')
      expect(scheme['--mantine-color-teal-light']).toBe('var(--hg-accent-secondary-soft)')
      expect(scheme['--mantine-color-ember-light-color']).toBe('var(--hg-text-accent)')
    }
  })

  it('maps Mantine colour names onto the Scent Trail tones', () => {
    expect([undefined, 'orange', 'teal', 'red.6', 'yellow', 'blue', 'grape', 'gray', '#123456'].map(toneOf)).toEqual([
      'ember',
      'ember',
      'trail',
      'danger',
      'warning',
      'info',
      'review',
      'neutral',
      undefined
    ])
  })

  it('resolves the added button variants to tokens', () => {
    const primary = variantColorResolver({ color: 'ember', theme: full, variant: 'primary' })
    expect(primary.background).toBe('var(--hg-accent-primary)')
    expect(primary.color).toBe('var(--hg-text-on-accent)')
    const ghost = variantColorResolver({ color: 'ember', theme: full, variant: 'subtle' })
    expect(ghost.color).toBe('var(--hg-text-secondary)')
    const filledDanger = variantColorResolver({ color: 'red', theme: full, variant: 'filled' })
    expect(filledDanger.background).toBe('var(--hg-status-danger)')
    expect(variantColorResolver({ color: 'red', theme: full, variant: 'subtle' }).color).toBe('var(--hg-status-danger)')
  })
})

describe('theme preference', () => {
  it('round-trips System / Light / Dark through Mantine colour schemes', () => {
    expect(THEME_PREFERENCES.map(schemeOf)).toEqual(['auto', 'light', 'dark'])
    expect(THEME_PREFERENCES.map((p) => preferenceOf(schemeOf(p)))).toEqual([...THEME_PREFERENCES])
  })
})
