import { useEffect, useState } from 'react'
import type { QueueState } from '@shared/queue-types'
import { api } from '../../api'

/** The bulk tailoring queue, kept current by `queue:changed`; `null` until loaded. */
export function useQueue(): [QueueState | null, (s: QueueState) => void] {
  const [state, setState] = useState<QueueState | null>(null)
  useEffect(() => {
    let live = true
    const off = api.on('queue:changed', (s) => setState(s))
    api.queue.state().then(
      (s) => live && setState((cur) => cur ?? s),
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return [state, setState]
}
