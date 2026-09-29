import type { JobText } from './knowledge-graph'

/** `window.huntgry.graph`: inputs for the knowledge graph that are not in the master profile. */
export interface GraphApi {
  /** `job-description.md` of every application folder in the workspace, for the jobs overlay. */
  jobDescriptions(): Promise<JobText[]>
}

export const GRAPH_CHANNELS = {
  jobDescriptions: 'graph:job-descriptions'
} as const
