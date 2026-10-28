import { useEffect, useState } from 'react'
import { Alert, Button, Group, Text } from '@mantine/core'
import { IconLink, IconLogout, IconRefresh } from '@tabler/icons-react'
import type { JobrightAccount } from '@shared/explore-types'
import { api, errorText } from '../../api'
import { StatusPill } from '../../components/ui'
import { SettingsCard } from './SettingsCard'

type Busy = 'connect' | 'check' | 'disconnect' | null

/** "Checked 5 min ago" for the last time a Jobright page said whether the user is signed in. */
export function checkedLabel(checkedAt: string | null, now = Date.now()): string {
  if (!checkedAt) return 'Not checked yet'
  const minutes = Math.round((now - Date.parse(checkedAt)) / 60_000)
  if (!Number.isFinite(minutes)) return 'Not checked yet'
  if (minutes < 1) return 'Checked just now'
  if (minutes < 60) return `Checked ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `Checked ${hours} h ago`
  return `Checked ${Math.round(hours / 24)} days ago`
}

/**
 * Settings → Jobright (#146): sign the hidden job-board browser in to Jobright once, so jobs added from
 * Explore link the employer's own posting instead of Jobright's page.
 */
export function JobrightCard() {
  const [account, setAccount] = useState<JobrightAccount | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.explore.account().then(setAccount, (err) => setError(errorText(err)))
  }, [])

  async function run(kind: Exclude<Busy, null>, call: () => Promise<JobrightAccount>) {
    setBusy(kind)
    setError(null)
    try {
      setAccount(await call())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const connected = account?.connected === true
  const status = connected ? (
    <StatusPill tone="success">Connected</StatusPill>
  ) : account?.connected === false ? (
    <StatusPill tone="warning">Not connected</StatusPill>
  ) : (
    <StatusPill tone="neutral">Not connected</StatusPill>
  )

  return (
    <SettingsCard
      title="Jobright"
      description="Jobright shows the employer's own posting link only to signed-in users. Sign in once and jobs you save from Jobs → Discover link the employer's posting, so Fetch full description and autofill use the real page."
      actions={status}
    >
      <Text size="sm" c="dimmed" mb="sm">
        {busy === 'connect'
          ? 'Sign in on Jobright in the window that opened. It closes once you are signed in; you can also close it yourself.'
          : connected
            ? `Signed in. ${checkedLabel(account?.checkedAt ?? null)}.`
            : `You sign in on Jobright's own page; Huntgry never sees your password. ${checkedLabel(account?.checkedAt ?? null)}.`}
      </Text>
      {error && (
        <Alert color="danger" variant="light" mb="sm" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Group gap="xs">
        <Button
          size="xs"
          leftSection={<IconLink size={14} />}
          variant={connected ? 'default' : 'filled'}
          loading={busy === 'connect'}
          disabled={!!busy && busy !== 'connect'}
          onClick={() => void run('connect', () => api.explore.connect())}
        >
          {connected ? 'Reconnect' : 'Connect Jobright'}
        </Button>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconRefresh size={14} />}
          loading={busy === 'check'}
          disabled={!!busy && busy !== 'check'}
          onClick={() => void run('check', () => api.explore.checkAccount())}
        >
          Check sign-in
        </Button>
        {connected && (
          <Button
            size="xs"
            variant="subtle"
            color="danger"
            leftSection={<IconLogout size={14} />}
            loading={busy === 'disconnect'}
            disabled={!!busy && busy !== 'disconnect'}
            onClick={() => void run('disconnect', () => api.explore.disconnect())}
          >
            Disconnect
          </Button>
        )}
      </Group>
    </SettingsCard>
  )
}
