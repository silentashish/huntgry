import { useRef, useState, type ReactNode } from 'react'
import { Button, Group, Modal, Text } from '@mantine/core'
import type { ApplicationTracking } from '@shared/applications-types'
import { api, errorText } from '../../api'
import { useNavigation } from '../../navigation'
import { alreadyAppliedText, trackingFor } from './blocker'

interface Target {
  id: string
  /** The application's tracking; looked up when absent, so an application already marked applied always asks first. */
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
  // A ref, not state: a second click in the same frame must already see the first one.
  const inFlight = useRef(false)

  /** Runs `fn` unless another Apply of this hook is pending (the service also refuses concurrent starts). */
  async function exclusive(fn: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      onError(errorText(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function start(id: string) {
    void exclusive(async () => {
      await api.apply.start(id)
      navigate('browser')
    })
  }

  function apply(target: Target) {
    void exclusive(async () => {
      const tracking = await trackingFor(target, (id) => api.applications.get(id))
      if (tracking?.status === 'applied') {
        setConfirm({ ...target, tracking })
        return
      }
      await api.apply.start(target.id)
      navigate('browser')
    })
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
            if (id) start(id)
          }}
        >
          Open apply page
        </Button>
      </Group>
    </Modal>
  )
  return { apply, busy, modal }
}
