import { Radio } from '@mantine/core'
import { THEME_PREFERENCE_LABELS, THEME_PREFERENCES, useThemePreference, type ThemePreference } from '../../theme'
import { SettingsCard } from './SettingsCard'
import classes from './settings.module.css'

/**
 * Settings → Appearance (#116, Figma "Settings" → Appearance): System / Light / Dark. The same
 * preference as the sidebar toggle (`useThemePreference`, stored by the MantineProvider).
 */
export function AppearanceCard() {
  const { preference, setPreference } = useThemePreference()
  return (
    <SettingsCard
      title="Appearance"
      description="Huntgry follows the system appearance by default. The toggle in the sidebar sets the same choice."
    >
      <Radio.Group value={preference} onChange={(v) => setPreference(v as ThemePreference)} aria-label="Appearance">
        <div className={classes.schemes}>
          {THEME_PREFERENCES.map((p) => (
            <Radio.Card
              key={p}
              value={p}
              className={classes.scheme}
              data-checked={preference === p || undefined}
              withBorder={false}
            >
              <div className={classes.schemePreview} data-scheme={p} aria-hidden />
              <div className={classes.schemeLabel}>
                <Radio.Indicator size="sm" />
                {THEME_PREFERENCE_LABELS[p]}
              </div>
            </Radio.Card>
          ))}
        </div>
      </Radio.Group>
    </SettingsCard>
  )
}
