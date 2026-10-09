import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Group, Modal, Paper, Stack, Text } from '@mantine/core'
import { IconCheck, IconDeviceMobile } from '@tabler/icons-react'
import type { RemotePairingInfo, RemoteState } from '@shared/remote-types'
import { api, errorText } from '../../api'

/**
 * The approve step of pairing (#37): "Pair '<device name>'?" with Approve / Deny. Shown inside the
 * "Pair a phone" modal while it is open, and by `PairingPrompt` (mounted once for the whole app)
 * when a phone's hello arrives after the modal was closed.
 */

// ── whether the "Pair a phone" modal is on screen (it shows the request itself) ─────────────────

let modalOpen = false
const listeners = new Set<() => void>()

export const pairModal = {
  set(open: boolean): void {
    modalOpen = open
    for (const l of listeners) l()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  isOpen: (): boolean => modalOpen
}

/** Requests waiting for Approve / Deny. */
export const waitingRequests = (state: RemoteState | null): RemotePairingInfo[] => (state?.pairings ?? []).filter((p) => p.status === 'scanned' || p.status === 'approving')

/** "m:ss" left until `iso`. */
export function countdown(iso: string, now: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** Re-renders every second while `active`. */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function ApprovePanel({ request, onDecided }: { request: RemotePairingInfo; onDecided?: (state: RemoteState) => void }) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  async function decide(approve: boolean) {
    setBusy(approve ? 'approve' : 'deny')
    setError(null)
    try {
      const next = approve ? await api.remote.approvePairing(request.id) : await api.remote.denyPairing(request.id)
      onDecided?.(next)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const name = request.deviceName ?? 'a phone'
  return (
    <Paper withBorder radius="md" p="sm" style={{ borderColor: 'var(--mantine-color-orange-filled)' }} data-testid="pair-approve">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="sm" wrap="nowrap">
          <IconDeviceMobile size={20} color="var(--mantine-color-orange-filled)" />
          <div>
            <Text fw={600}>Pair “{name}”?</Text>
            <Text size="xs" c="dimmed">
              Just scanned · Huntgry {request.appVersion ?? ''} · decide within {countdown(request.decideBy, now)}
            </Text>
          </div>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="subtle" color="gray" disabled={busy !== null || request.status === 'approving'} loading={busy === 'deny'} onClick={() => void decide(false)}>
            Deny
          </Button>
          <Button size="xs" color="orange" leftSection={<IconCheck size={14} />} disabled={busy !== null} loading={busy === 'approve' || request.status === 'approving'} onClick={() => void decide(true)}>
            Approve
          </Button>
        </Group>
      </Group>
      {(error ?? request.error) && (
        <Text size="xs" c="red" mt={6}>
          {error ?? request.error}
        </Text>
      )}
    </Paper>
  )
}

/**
 * App-wide: a phone scanned a code and the "Pair a phone" modal is closed (or the owner is on
 * another page). Closing this dialog only hides it; the request stays in Settings until it expires.
 */
export function PairingPrompt() {
  const [state, setState] = useState<RemoteState | null>(null)
  const [hidden, setHidden] = useState<string[]>([])
  const open = useSyncExternalStore(pairModal.subscribe, pairModal.isOpen)

  useEffect(() => {
    void api.remote.state().then(setState, () => undefined)
    return api.on('remote:state', setState)
  }, [])

  const requests = waitingRequests(state).filter((r) => !hidden.includes(r.id))
  return (
    <Modal opened={!open && requests.length > 0} onClose={() => setHidden((h) => [...h, ...requests.map((r) => r.id)])} title="A phone wants to pair" centered size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Only approve a phone you are holding. It will be able to see this Mac&apos;s queue and runs and control them.
        </Text>
        {requests.map((r) => (
          <ApprovePanel key={r.id} request={r} onDecided={setState} />
        ))}
      </Stack>
    </Modal>
  )
}
