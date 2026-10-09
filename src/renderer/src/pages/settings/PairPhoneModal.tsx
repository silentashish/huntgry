import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Center, Divider, Group, Image, Loader, Modal, Stack, Text, Title } from '@mantine/core'
import { IconClock, IconQrcode, IconRefresh, IconShieldCheck } from '@tabler/icons-react'
import type { RemotePairingStart, RemoteState } from '@shared/remote-types'
import { api, errorText } from '../../api'
import { ApprovePanel, countdown, pairModal, useNow } from './PairingPrompt'

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
  const now = useNow(opened)

  async function fresh() {
    setLoading(true)
    setError(null)
    try {
      setCode(await api.remote.startPairing())
    } catch (e) {
      setCode(null)
      setError(errorText(e))
    } finally {
      setLoading(false)
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
    if (code && status === 'waiting') void api.remote.cancelPairing(code.pairingId).catch(() => undefined)
    setCode(null)
    onClose()
  }

  return (
    <Modal
      opened={opened}
      onClose={close}
      size={560}
      radius="lg"
      centered
      title={
        <Group gap="xs">
          <IconQrcode size={22} color="var(--mantine-color-orange-filled)" />
          <Title order={3}>Pair a phone</Title>
        </Group>
      }
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group align="center" gap="lg" wrap="nowrap">
          <Box bg="white" p={8} style={{ borderRadius: 12, width: 196, height: 196, flex: 'none', position: 'relative' }}>
            {code && !expired && status === 'waiting' ? (
              <Image src={code.qrDataUrl} alt="Pairing code" w={180} h={180} style={{ imageRendering: 'pixelated' }} />
            ) : (
              <Center h="100%">
                {loading ? (
                  <Loader size="sm" />
                ) : (
                  <Text size="sm" c="dark.6" ta="center">
                    {status === 'paired' ? 'Paired' : status === 'scanned' || status === 'approving' ? 'Scanned' : status === 'denied' ? 'Denied' : 'Code expired'}
                  </Text>
                )}
              </Center>
            )}
          </Box>
          <Stack gap={8}>
            <Text fw={600} size="lg">
              Scan with Huntgry Mobile
            </Text>
            <Text size="sm" c="dimmed">
              Open the app on your phone, tap Pair, and point it here. The code carries the relay URL and a one-time secret; it never leaves this screen.
            </Text>
            <Group gap="md">
              {code && status === 'waiting' && !expired && (
                <Group gap={6}>
                  <IconClock size={16} color="var(--mantine-color-yellow-filled)" />
                  <Text size="sm" ff="monospace" c="yellow.6">
                    Expires in {countdown(code.expiresAt, now)}
                  </Text>
                </Group>
              )}
              <Button size="compact-sm" variant="subtle" color="gray" leftSection={<IconRefresh size={14} />} loading={loading} onClick={() => void fresh()}>
                New code
              </Button>
            </Group>
            <Group gap={6} wrap="nowrap">
              <IconShieldCheck size={16} color="var(--mantine-color-teal-filled)" />
              <Text size="xs" ff="monospace" c="dimmed">
                End-to-end encrypted · the relay only forwards ciphertext
              </Text>
            </Group>
          </Stack>
        </Group>
        {info && (info.status === 'scanned' || info.status === 'approving') && (
          <>
            <Divider />
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
