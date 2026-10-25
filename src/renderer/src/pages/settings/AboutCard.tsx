import { Anchor, Group, Text } from '@mantine/core'
import { APP_VERSION } from '../../components/shell/version'
import { SettingsCard } from './SettingsCard'

const REPO = 'https://github.com/silentashish/huntgry'

/** The GitHub release a version came from (`v<version>`, the tag the release workflow builds), or every release. */
export function releaseUrl(version: string = APP_VERSION): string {
  return version ? `${REPO}/releases/tag/v${version}` : `${REPO}/releases`
}

/**
 * Settings → About (#167): the version, from package.json like `app.getVersion()` and the macOS About
 * panel, so it is the release's own number (the release workflow refuses a tag that disagrees with it).
 */
export function AboutCard({ version = APP_VERSION }: { version?: string }) {
  return (
    <SettingsCard title="About" description="Huntgry runs on this computer; updates come from GitHub Releases.">
      <Group gap="xs" align="baseline">
        <Text fw={600}>Huntgry</Text>
        <Text ff="monospace" data-testid="app-version">
          {version || 'version unknown'}
        </Text>
      </Group>
      <Group gap="md" mt="xs">
        <Anchor href={releaseUrl(version)} target="_blank" rel="noreferrer" size="sm">
          Release notes
        </Anchor>
        <Anchor href={`${REPO}/blob/main/docs/install.md`} target="_blank" rel="noreferrer" size="sm">
          Install and update guide
        </Anchor>
      </Group>
    </SettingsCard>
  )
}
