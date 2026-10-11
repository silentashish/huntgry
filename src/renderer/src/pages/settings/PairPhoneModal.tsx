import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Center, Divider, Group, Image, Loader, Modal, Stack, Text, Title } from '@mantine/core'
import { IconClock, IconQrcode, IconRefresh, IconShieldCheck } from '@tabler/icons-react'
import type { RemotePairingStart, RemoteState } from '@shared/remote-types'
import { api, errorText } from '../../api'
import { MonoLabel } from '../../components/ui'
import { ApprovePanel, countdown, pairModal, useNow } from './PairingPrompt'
import classes from './settings.module.css'

/**
 * Settings → Remote control → "Pair a phone" (#37, Figma "Settings — Pair a phone"): a one-time
 * QR rendered by the main process (the renderer only gets the image), its 2-minute countdown,
 * "New code", and the approve step once a phone answers. Closing withdraws a code nobody scanned.
 */
export function PairPhoneModal({ opened, onClose, state }: { opened: boolean; onClose: () => void; state: RemoteState | null }) {
  const [code, setCode] = useState<RemotePairingStart | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requested = useRef(false)
  /** Bumped by every request and by close(), so a code that arrives after either is withdrawn, not shown. */
  const generation = useRef(0)
  const now = useNow(opened)

  async function fresh() {
    const mine = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await api.remote.startPairing()
      if (generation.current !== mine) {
        void api.remote.cancelPairing(next.pairingId).catch(() => undefined)
        return
      }
      setCode(next)
    } catch (e) {
      if (generation.current !== mine) return
      setCode(null)
      setError(errorText(e))
    } finally {
      if (generation.current === mine) setLoading(false)
    }
  }

  useEffect(() => {
    pairModal.set(opened)
    if (opened && !requested.current) {
      requested.current = true
      void fresh()
    }
    if (!opened) requested.current = false
    return () => pairModal.set(false)
  }, [opened])

  const info = code ? state?.pairings.find((p) => p.id === code.pairingId) : undefined
  const status = info?.status ?? (code ? 'waiting' : undefined)
  const expired = status === 'expired' || (status === 'waiting' && code !== null && Date.parse(code.expiresAt) <= now)

  function close() {
    generation.current += 1
    setLoading(false)
    if (code && status === 'waiting') void api.remote.cancelPairing(code.pairingId).catch(() => undefined)
    setCode(null)
    onClose()
  }

  return (
    <Modal
      opened={opened}
      onClose={close}
      size={560}
      radius="var(--hg-radius-2xl)"
      padding={24}
      centered
      title={
        <Group gap={10} wrap="nowrap">
          <IconQrcode size={20} color="var(--hg-accent-primary)" />
          <Title order={3} className={classes.modalTitle}>
            Pair a phone
          </Title>
        </Group>
      }
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group align="center" gap={20} wrap="nowrap">
          <div className={classes.qr}>
            {code && !expired && (status === 'waiting' || status === 'scanned' || status === 'approving') ? (
              <Image src={code.qrDataUrl} alt="Pairing code" w={168} h={168} style={{ imageRendering: 'pixelated', opacity: status === 'waiting' ? 1 : 0.25 }} />
            ) : (
              <Center h="100%">{loading ? <Loader size="sm" color="var(--hg-ink-700)" /> : <span className={classes.qrNote}>{status === 'paired' ? 'Paired' : status === 'denied' ? 'Denied' : 'Code expired'}</span>}</Center>
            )}
          </div>
          <Stack gap={10} style={{ minWidth: 0 }}>
            <Text fw={600} fz={16} lh="22px">
              Scan with Huntgry Mobile
            </Text>
            <Text size="sm" c="dimmed">
              Open the app on your phone, tap Pair, and point it here. The code carries the relay URL and a one-time secret; it never leaves this screen.
            </Text>
            <Group gap={8}>
              {code && status === 'waiting' && !expired && (
                <Group gap={8} wrap="nowrap">
                  <IconClock size={14} color="var(--hg-status-warning)" />
                  <Text span ff="monospace" fz={11} fw={500} lts="0.06em" c="var(--hg-status-warning)">
                    Expires in {countdown(code.expiresAt, now)}
                  </Text>
                </Group>
              )}
              <Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} loading={loading} onClick={() => void fresh()}>
                New code
              </Button>
            </Group>
            <Group gap={6} wrap="nowrap">
              <IconShieldCheck size={14} color="var(--hg-accent-secondary)" style={{ flex: 'none' }} />
              <MonoLabel size="xs">End-to-end encrypted · the relay only forwards ciphertext</MonoLabel>
            </Group>
          </Stack>
        </Group>
        {info && (info.status === 'scanned' || info.status === 'approving') && (
          <>
            <Divider color="var(--hg-border-subtle)" />
            <ApprovePanel request={info} />
          </>
        )}
        {info?.status === 'paired' && (
          <Alert color="green" variant="light" title={`Paired “${info.deviceName ?? 'phone'}”`}>
            The phone is connecting now; it shows in the list of paired phones.{' '}
            <Button size="compact-sm" variant="subtle" onClick={close}>
              Done
            </Button>
          </Alert>
        )}
        {info?.status === 'denied' && (
          <Alert color="gray" variant="light">
            {info.error ?? `“${info.deviceName ?? 'The phone'}” was not paired.`} Show a new code to try again.
          </Alert>
        )}
      </Stack>
    </Modal>
  )
}
