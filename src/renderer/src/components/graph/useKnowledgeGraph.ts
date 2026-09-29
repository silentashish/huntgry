import { useEffect, useMemo, useState } from 'react'
import { buildKnowledgeGraph, type JobText, type KnowledgeGraph } from '@shared/knowledge-graph'
import type { MasterProfile } from '@shared/master-profile'
import { api, errorText } from '../../api'

/**
 * Loads the master profile and the workspace's job descriptions, then builds
 * the graph. Re-reads on mount, so a saved profile shows up on the next visit.
 */
export function useKnowledgeGraph(includeJobs = true): {
  graph: KnowledgeGraph | null
  jobs: JobText[]
  error: string | null
  reload(): void
} {
  const [profile, setProfile] = useState<MasterProfile | null>(null)
  const [jobs, setJobs] = useState<JobText[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    Promise.all([api.profile.read(), api.graph.jobDescriptions().catch(() => [] as JobText[])])
      .then(([doc, j]) => {
        if (!alive) return
        setProfile(doc.profile)
        setJobs(j)
        setError(null)
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [tick])

  // With the overlay off, nothing job-derived (job nodes, gaps, job counts) is in the graph at all.
  const graph = useMemo(
    () => (profile ? buildKnowledgeGraph(profile, includeJobs ? jobs : []) : null),
    [profile, jobs, includeJobs]
  )
  return { graph, jobs, error, reload: () => setTick((t) => t + 1) }
}
