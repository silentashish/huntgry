import { useComputedColorScheme, useMantineColorScheme, type MantineColorScheme } from '@mantine/core'

/** What the user picked in the sidebar toggle or Settings → Appearance. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** The order the toggle and the Appearance card show them in. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark'
}

export function preferenceOf(scheme: MantineColorScheme): ThemePreference {
  return scheme === 'auto' ? 'system' : scheme
}

export function schemeOf(preference: ThemePreference): MantineColorScheme {
  return preference === 'system' ? 'auto' : preference
}

export interface ThemePreferenceState {
  /** The stored choice; `system` follows the OS appearance. */
  preference: ThemePreference
  setPreference(preference: ThemePreference): void
  /** The scheme on screen now (`system` resolved). */
  resolved: 'light' | 'dark'
}

/**
 * System / Light / Dark, persisted by the MantineProvider's colour scheme manager (localStorage key
 * `huntgry-color-scheme`). Must be used under the app's MantineProvider.
 */
export function useThemePreference(): ThemePreferenceState {
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const resolved = useComputedColorScheme('dark', { getInitialValueInEffect: false })
  return {
    preference: preferenceOf(colorScheme),
    setPreference: (preference) => setColorScheme(schemeOf(preference)),
    resolved
  }
}
