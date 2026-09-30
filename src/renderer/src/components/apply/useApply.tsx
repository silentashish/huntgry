import { useState, type ReactNode } from 'react'
import { Button, Group, Modal, Text } from '@mantine/core'
import type { ApplicationTracking } from '@shared/applications-types'
import { api, errorText } from '../../api'
import { useNavigation } from '../../navigation'
import { alreadyAppliedText } from './blocker'

interface Target {
  id: string
  /** When known: an application already marked applied asks before opening again. */
  tracking?: ApplicationTracking
}

/**
 * Starts auto-apply for an application and shows the Browser page, where the
 * Apply panel follows the session. Errors (no resume.pdf, no posting URL,
 * refused address) go to `onError`.
 */
export function useApply(onError: (message: string) => void): {
  apply(target: Target): void
  busy: boolean
  modal: ReactNode
} {
  const { navigate } = useNavigation()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<Target | null>(null)

  async function start(id: string) {
    setBusy(true)
    try {
      await api.apply.start(id)
      navigate('browser')
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function apply(target: Target) {
    if (target.tracking?.status === 'applied') setConfirm(target)
    else void start(target.id)
  }

  const modal = (
    <Modal opened={confirm !== null} onClose={() => setConfirm(null)} title="Already applied" centered>
      <Text size="sm">{alreadyAppliedText(confirm?.tracking?.appliedAt)} Open the apply page anyway?</Text>
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            const id = confirm?.id
            setConfirm(null)
            if (id) void start(id)
          }}
        >
          Open apply page
        </Button>
      </Group>
    </Modal>
  )
  return { apply, busy, modal }
}
