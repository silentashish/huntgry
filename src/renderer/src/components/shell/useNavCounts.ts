import { useEffect, useState } from 'react'
import type { RunStatus } from '@shared/runner-types'
import { api } from '../../api'
import { runCounts, type NavCounts } from './counts'

export type { NavCounts }

/**
 * Badge counts for Tailor and Review. Runs come from `listRuns` once, then from `runner:run` events; the
 * review list is read again (debounced) when applications or the pipeline change.
 */
export function useNavCounts(): NavCounts {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, RunStatus>>(new Map())
  const [review, setReview] = useState(0)

  useEffect(() => {
    let live = true
    const off = api.on('runner:run', (run) =>
      setStatuses((cur) => {
        if (cur.get(run.id) === run.status) return cur
        return new Map(cur).set(run.id, run.status)
      })
    )
    api.runner.listRuns().then(
      (runs) => {
        if (!live) return
        // Events that arrived meanwhile are newer than the list.
        setStatuses((cur) => new Map([...runs.map((r) => [r.id, r.status] as const), ...cur]))
      },
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      api.review.list().then(
        (items) => live && setReview(items.length),
        () => undefined
      )
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 800)
    }
    void load()
    const offApps = api.on('applications:changed', soon)
    const offPipeline = api.on('pipeline:changed', soon)
    return () => {
      live = false
      clearTimeout(timer)
      offApps()
      offPipeline()
    }
  }, [])

  return { ...runCounts(statuses.values()), review }
}
