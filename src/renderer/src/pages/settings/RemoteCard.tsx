import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Collapse, Group, NumberInput, PasswordInput, ScrollArea, Stack, Switch, Table, Text, TextInput, Title, UnstyledButton } from '@mantine/core'
import { IconChevronDown, IconChevronRight, IconDeviceMobile, IconQrcode } from '@tabler/icons-react'
import type { RemoteAuditEntry, RemoteConnection, RemoteState } from '@shared/remote-types'
import { api, errorText } from '../../api'
import { PairPhoneModal } from './PairPhoneModal'
import { ApprovePanel, waitingRequests } from './PairingPrompt'

const CONNECTION: Record<RemoteConnection, { color: string; label: string }> = {
  disabled: { color: 'gray', label: 'Off' },
  unconfigured: { color: 'gray', label: 'Not set up' },
  'credentials-unreadable': { color: 'red', label: 'Credentials unreadable' },
  offline: { color: 'orange', label: 'Offline' },
  connecting: { color: 'blue', label: 'Connecting' },
  online: { color: 'green', label: 'Connected' }
}

/** Why a relay URL is refused, or `null` (the main process checks again). */
export function relayUrlProblem(text: string): string | null {
  const value = text.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Not a valid URL.'
  }
  if (url.protocol !== 'https:') return 'The relay URL must start with https:// (TLS only).'
  if (url.username || url.password) return 'The relay URL must not carry credentials.'
  if (url.search || url.hash) return 'The relay URL must not have a query or fragment.'
  return null
}

/** "2 min ago", "3 h ago", or a date. */
export function lastSeenText(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'Never'
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

const hours = (seconds: number): number => Math.round((seconds / 3600) * 100) / 100

/**
 * Settings → Remote control (ADR-0001, #36, #37; Figma "Settings" → Remote control): the relay
 * URL and admin token, Enable, Pair a phone, the paired phones with Revoke, Rotate relay
 * credentials, Unpair everything, the "credentials unreadable" recovery, the two privacy
 * toggles, the command TTLs and the audit log. Only ids, booleans, numbers, the URL and the
 * token typed here go to the main process; the token is never shown again.
 */
export function RemoteCard() {
  const [state, setState] = useState<RemoteState | null>(null)
  const [relayUrl, setRelayUrl] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [costly, setCostly] = useState<number | string>('')
  const [standard, setStandard] = useState<number | string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [confirm, setConfirm] = useState<'unpair' | 'rotate' | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)
  const [audit, setAudit] = useState<RemoteAuditEntry[] | null>(null)

  useEffect(() => {
    void api.remote.state().then(setState, (e) => setError(errorText(e)))
    return api.on('remote:state', setState)
  }, [])

  // The form follows the saved values until the owner edits it.
  const savedUrl = state?.relayUrl ?? ''
  useEffect(() => setRelayUrl(savedUrl), [savedUrl])
  const savedCostly = state ? hours(state.commandTtl.costlySeconds) : ''
  const savedDefault = state ? hours(state.commandTtl.defaultSeconds) : ''
  useEffect(() => setCostly(savedCostly), [savedCostly])
  useEffect(() => setStandard(savedDefault), [savedDefault])

  useEffect(() => {
    if (!auditOpen) return
    void api.remote.audit().then(setAudit, (e) => setError(errorText(e)))
  }, [auditOpen])

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
  const unreadable = state?.connection === 'credentials-unreadable'
  const configured = !!state?.relayUrl
  const urlProblem = relayUrlProblem(relayUrl)
  const ttlChanged = state !== null && (Number(costly) !== savedCostly || Number(standard) !== savedDefault)
  // The main process accepts 1 minute to 7 days (COMMAND_TTL_BOUNDS); an empty box is not 0.
  const ttlValid = [costly, standard].every((h) => h !== '' && Number.isFinite(Number(h)) && Math.round(Number(h) * 3600) >= 60 && Math.round(Number(h) * 3600) <= 7 * 24 * 3600)
  const requests = waitingRequests(state)
  const saveLabel = unreadable ? 'Recover' : configured ? 'Replace room' : 'Save'

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title order={4}>Remote control</Title>
          <Text size="sm" c="dimmed">
            Control the queue from your phone through your own end-to-end encrypted relay. Huntgry only connects out to the relay; nothing listens on this Mac.
          </Text>
        </div>
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          {status && (
            <Badge color={status.color} variant="light">
              {status.label}
            </Badge>
          )}
          <Button size="xs" color="orange" leftSection={<IconQrcode size={14} />} disabled={state?.connection !== 'online'} onClick={() => setPairing(true)}>
            Pair a phone
          </Button>
        </Group>
      </Group>
      <Stack gap="sm">
        {error && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {state?.error && state.connection !== 'online' && !unreadable && (
          <Alert color="orange" variant="light">
            {state.error}
          </Alert>
        )}
        {unreadable && (
          <Alert color="red" variant="light" title="Relay credentials unreadable">
            This Mac cannot decrypt the saved relay credentials (a Keychain reset or a copied profile). Enter the relay URL and admin token again and choose Recover: Huntgry creates a new room, and every phone must pair again.
          </Alert>
        )}
        {state && (
          <>
            <Switch label="Enable remote control" checked={state.connection !== 'disabled'} disabled={busy} onChange={(e) => void run(() => api.remote.setEnabled(e.currentTarget.checked))} />
            <Group align="flex-start" gap="sm" grow>
              <TextInput label="Relay URL" placeholder="https://huntgry-relay.example.workers.dev" value={relayUrl} error={urlProblem} onChange={(e) => setRelayUrl(e.currentTarget.value)} styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }} />
              <PasswordInput
                label="Admin token"
                placeholder={configured ? 'Saved (never shown again)' : 'From wrangler secret put ADMIN_TOKEN'}
                value={adminToken}
                onChange={(e) => setAdminToken(e.currentTarget.value)}
                autoComplete="off"
              />
            </Group>
            {(adminToken.trim() || !configured) && (
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" c="dimmed">
                  {configured || unreadable
                    ? 'This creates a new room on the relay; every phone must pair again. The token is stored encrypted in the Keychain.'
                    : 'Saving creates your room on the relay once. The token is stored encrypted in the Keychain.'}
                </Text>
                <Button
                  size="xs"
                  loading={busy}
                  disabled={!relayUrl.trim() || !adminToken.trim() || urlProblem !== null}
                  onClick={() =>
                    void run(async () => {
                      const next = await api.remote.configure({ relayUrl: relayUrl.trim(), adminToken })
                      setAdminToken('')
                      return next
                    })
                  }
                >
                  {saveLabel}
                </Button>
              </Group>
            )}
            <Group gap="xl">
              <Switch label="Show details in notifications (visible to the relay, Expo and Apple/Google)" checked={state.notificationDetails} disabled={busy} onChange={(e) => void run(() => api.remote.setNotificationDetails(e.currentTarget.checked))} />
              <Switch label="Show transcripts on the phone" checked={state.transcripts} disabled={busy} onChange={(e) => void run(() => api.remote.setTranscripts(e.currentTarget.checked))} />
            </Group>
            <Group align="flex-end" gap="sm">
              <NumberInput label="Costly commands expire after" description="Enqueue, reply, start pipeline, approve" suffix=" h" min={1 / 60} max={168} step={0.5} decimalScale={2} value={costly} onChange={setCostly} w={260} />
              <NumberInput label="Other commands expire after" description="Reads, pause, cancel, retry, stop" suffix=" h" min={1 / 60} max={168} step={1} decimalScale={2} value={standard} onChange={setStandard} w={260} />
              {ttlChanged && (
                <Button
                  size="xs"
                  variant="default"
                  disabled={busy || !ttlValid}
                  onClick={() => void run(() => api.remote.setCommandTtl({ costlySeconds: Math.round(Number(costly) * 3600), defaultSeconds: Math.round(Number(standard) * 3600) }))}
                >
                  Save TTLs
                </Button>
              )}
            </Group>
            {requests.map((r) => (
              <ApprovePanel key={r.id} request={r} onDecided={setState} />
            ))}
            {state.devices.length > 0 ? (
              <Table verticalSpacing="xs" withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Phone</Table.Th>
                    <Table.Th>Paired</Table.Th>
                    <Table.Th>Last seen</Table.Th>
                    <Table.Th w={90} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {state.devices.map((d) => (
                    <Table.Tr key={d.id}>
                      <Table.Td>
                        <Group gap={8} wrap="nowrap">
                          <IconDeviceMobile size={16} />
                          <Text size="sm">{d.name}</Text>
                          {d.needsRepair && (
                            <Badge color="yellow" variant="light" size="sm" title="Its counter rewound or the relay credentials were rotated: pair it again">
                              Pair again
                            </Badge>
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{new Date(d.pairedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{lastSeenText(d.lastSeen)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Button size="compact-xs" variant="subtle" color="gray" disabled={busy} onClick={() => void run(() => api.remote.revoke(d.id))}>
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
            {(state.devices.length > 0 || configured) &&
              (confirm ? (
                <Group gap="xs">
                  <Text size="sm">
                    {confirm === 'rotate'
                      ? 'Create a new room and delete the old one? Every phone must pair again.'
                      : 'Remove every phone, give this Mac a new identity and a new room?'}
                  </Text>
                  <Button
                    size="xs"
                    color="red"
                    loading={busy}
                    onClick={() =>
                      void run(() => (confirm === 'rotate' ? api.remote.rotate() : api.remote.unpairAll())).then(() => setConfirm(null))
                    }
                  >
                    {confirm === 'rotate' ? 'Rotate' : 'Unpair everything'}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                </Group>
              ) : (
                <Group gap="xs">
                  {configured && (
                    <Button size="xs" variant="default" disabled={busy} onClick={() => setConfirm('rotate')}>
                      Rotate relay credentials
                    </Button>
                  )}
                  <Button size="xs" variant="light" color="red" disabled={busy} onClick={() => setConfirm('unpair')}>
                    Unpair everything
                  </Button>
                </Group>
              ))}
            <UnstyledButton onClick={() => setAuditOpen((o) => !o)} aria-expanded={auditOpen}>
              <Group gap={6}>
                {auditOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                <Text size="sm" fw={500}>
                  Audit log
                </Text>
                <Text size="xs" c="dimmed">
                  last 200 remote commands in this workspace
                </Text>
              </Group>
            </UnstyledButton>
            <Collapse expanded={auditOpen}>
              {audit && audit.length === 0 && (
                <Text size="sm" c="dimmed">
                  No remote commands yet.
                </Text>
              )}
              {audit && audit.length > 0 && (
                <ScrollArea.Autosize mah={320}>
                  <Table verticalSpacing={4} fz="xs" stickyHeader>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Time</Table.Th>
                        <Table.Th>Phone</Table.Th>
                        <Table.Th>Command</Table.Th>
                        <Table.Th>Outcome</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {audit.map((a, i) => (
                        <Table.Tr key={`${a.deviceId}-${a.ts}-${i}`}>
                          <Table.Td>{a.ts ? new Date(a.ts).toLocaleString() : ''}</Table.Td>
                          <Table.Td>{a.device}</Table.Td>
                          <Table.Td ff="monospace">{a.command}</Table.Td>
                          <Table.Td>
                            <Badge size="xs" variant="light" color={a.outcome === 'ok' ? 'green' : a.outcome === 'started' ? 'yellow' : 'red'} title={a.error}>
                              {a.outcome === 'started' ? 'started' : a.outcome === 'ok' ? 'ok' : (a.error?.split(':')[0] ?? 'failed')}
                            </Badge>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              )}
            </Collapse>
          </>
        )}
      </Stack>
      <PairPhoneModal opened={pairing} onClose={() => setPairing(false)} state={state} />
    </Card>
  )
}
