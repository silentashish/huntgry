import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Collapse, Group, PasswordInput, Stack, Switch, Table, Text, TextInput, Title, UnstyledButton } from '@mantine/core'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import type { RemoteConnection, RemoteState } from '@shared/remote-types'
import { api, errorText } from '../../api'

const CONNECTION: Record<RemoteConnection, { color: string; label: string }> = {
  disabled: { color: 'gray', label: 'Off' },
  unconfigured: { color: 'gray', label: 'Not set up' },
  'credentials-unreadable': { color: 'red', label: 'Credentials unreadable' },
  offline: { color: 'orange', label: 'Offline' },
  connecting: { color: 'blue', label: 'Connecting' },
  online: { color: 'green', label: 'Connected' }
}

/**
 * Remote control (ADR-0001, #36): hidden behind a disclosure until pairing lands (#37). Turns
 * the relay session on or off, stores the relay URL and admin token, lists paired phones.
 */
export function RemoteCard() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<RemoteState | null>(null)
  const [relayUrl, setRelayUrl] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void api.remote.state().then(setState, (e) => setError(errorText(e)))
    return api.on('remote:state', setState)
  }, [open])

  async function run(job: () => Promise<RemoteState>) {
    setBusy(true)
    setError(null)
    try {
      setState(await job())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const status = state ? CONNECTION[state.connection] : null

  return (
    <Card withBorder radius="md" padding="lg">
      <UnstyledButton onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Group gap="xs">
          {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          <Title order={4}>Remote control (preview)</Title>
          {status && <Badge color={status.color} variant="light">{status.label}</Badge>}
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Stack gap="sm" mt="sm">
          <Text size="sm" c="dimmed">
            Control the queue from your phone through your own end-to-end encrypted relay. Huntgry only connects out to the relay; nothing listens on
            this Mac. Pairing a phone comes in a later update.
          </Text>
          {error && (
            <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {state?.error && state.connection !== 'online' && (
            <Alert color={state.connection === 'credentials-unreadable' ? 'red' : 'orange'} variant="light">
              {state.error}
            </Alert>
          )}
          {state && (
            <>
              <Switch
                label="Enable remote control"
                checked={state.connection !== 'disabled'}
                disabled={busy}
                onChange={(e) => void run(() => api.remote.setEnabled(e.currentTarget.checked))}
              />
              {state.relayUrl && (
                <Text size="sm">
                  Relay: <b>{state.relayUrl}</b>
                </Text>
              )}
              <Group align="flex-end" gap="sm">
                <TextInput label="Relay URL" placeholder="https://huntgry-relay.example.workers.dev" value={relayUrl} onChange={(e) => setRelayUrl(e.currentTarget.value)} style={{ flex: 2 }} />
                <PasswordInput label="Admin token" value={adminToken} onChange={(e) => setAdminToken(e.currentTarget.value)} style={{ flex: 1 }} />
                <Button
                  loading={busy}
                  disabled={!relayUrl.trim() || !adminToken.trim()}
                  onClick={() =>
                    void run(async () => {
                      const next = await api.remote.configure({ relayUrl, adminToken })
                      setAdminToken('')
                      return next
                    })
                  }
                >
                  {state.relayUrl ? 'Rotate' : 'Save'}
                </Button>
              </Group>
              <Switch label="Show details in notifications (visible to the relay, Expo and Apple/Google)" checked={state.notificationDetails} onChange={(e) => void run(() => api.remote.setNotificationDetails(e.currentTarget.checked))} />
              <Switch label="Show transcripts on the phone" checked={state.transcripts} onChange={(e) => void run(() => api.remote.setTranscripts(e.currentTarget.checked))} />
              {state.devices.length > 0 ? (
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Phone</Table.Th>
                      <Table.Th>Last seen</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {state.devices.map((d) => (
                      <Table.Tr key={d.id}>
                        <Table.Td>
                          {d.name} {d.needsRepair && <Badge color="orange">Pair again</Badge>}
                        </Table.Td>
                        <Table.Td>{d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'Never'}</Table.Td>
                        <Table.Td>
                          <Button size="xs" variant="default" color="red" disabled={busy} onClick={() => void run(() => api.remote.revoke(d.id))}>
                            Revoke
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              ) : (
                <Text size="sm" c="dimmed">
                  No phones paired.
                </Text>
              )}
              {(state.devices.length > 0 || state.relayUrl) && (
                <Group>
                  <Button variant="default" color="red" disabled={busy} onClick={() => void run(() => api.remote.unpairAll())}>
                    Unpair everything
                  </Button>
                </Group>
              )}
            </>
          )}
        </Stack>
      </Collapse>
    </Card>
  )
}
