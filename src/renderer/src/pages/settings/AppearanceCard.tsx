import { Radio } from '@mantine/core'
import { THEME_PREFERENCE_LABELS, THEME_PREFERENCES, useThemePreference } from '../../theme'
import { SettingsCard } from './SettingsCard'
import classes from './settings.module.css'

/**
 * Settings → Appearance (#116, Figma "Settings" → Appearance): System / Light / Dark. The same
 * preference as the sidebar toggle (`useThemePreference`, stored by the MantineProvider).
 *
 * The radiogroup is our own element: Mantine's `Radio.Group` puts `aria-label` and `label` on its
 * outer wrapper, which leaves its inner radiogroup without an accessible name.
 */
export function AppearanceCard() {
  const { preference, setPreference } = useThemePreference()
  return (
    <SettingsCard
      title="Appearance"
      description="Huntgry follows the system appearance by default. The toggle in the sidebar sets the same choice."
    >
      <div role="radiogroup" aria-label="Appearance" className={classes.schemes}>
        {THEME_PREFERENCES.map((p) => (
          <Radio.Card
            key={p}
            name="appearance"
            value={p}
            checked={preference === p}
            onClick={() => setPreference(p)}
            className={classes.scheme}
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
    </SettingsCard>
  )
}
