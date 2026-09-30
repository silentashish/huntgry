import { useEffect, useState } from 'react'
import type { PipelineState } from '@shared/pipeline-types'
import { api } from '../../api'

/** The unattended pipeline's state, kept current by `pipeline:changed`; `null` when there is none (or not loaded yet). */
export function usePipeline(): [PipelineState | null, (s: PipelineState | null) => void] {
  const [state, setState] = useState<PipelineState | null>(null)
  useEffect(() => {
    let live = true
    const off = api.on('pipeline:changed', (s) => setState(s))
    api.pipeline.state().then(
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

/** A clock that ticks every `ms`, for countdowns. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
