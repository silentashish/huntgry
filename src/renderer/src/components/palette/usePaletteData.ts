import { useEffect, useState } from 'react'
import type { ApplicationRecord } from '@shared/applications-types'
import type { Job } from '@shared/jobs-types'
import type { RunSummary } from '@shared/runner-types'
import { api } from '../../api'

export interface PaletteSources {
  jobs: Job[]
  applications: ApplicationRecord[]
  runs: RunSummary[]
  reviewIds: Set<string>
  /** Nothing loaded yet (first open). */
  loading: boolean
}

const EMPTY: PaletteSources = { jobs: [], applications: [], runs: [], reviewIds: new Set(), loading: true }

/**
 * Jobs, applications, runs and the review list, read each time the palette opens (the last answer stays
 * on screen meanwhile). A source that fails is left as it was; the palette still finds the rest.
 */
export function usePaletteData(opened: boolean): PaletteSources {
  const [data, setData] = useState<PaletteSources>(EMPTY)
  useEffect(() => {
    if (!opened) return
    let live = true
    void Promise.allSettled([api.jobs.list(), api.applications.list(), api.runner.listRuns(), api.review.list()]).then(
      ([jobs, apps, runs, review]) => {
        if (!live) return
        setData((cur) => ({
          jobs: jobs.status === 'fulfilled' ? jobs.value : cur.jobs,
          applications: apps.status === 'fulfilled' ? apps.value.applications : cur.applications,
          runs: runs.status === 'fulfilled' ? runs.value : cur.runs,
          reviewIds: review.status === 'fulfilled' ? new Set(review.value.map((r) => r.applicationId)) : cur.reviewIds,
          loading: false
        }))
      }
    )
    return () => {
      live = false
    }
  }, [opened])
  return data
}
