import type { ApplicationsApi } from './applications-types'
import type { ApplyApi } from './apply-types'
import type { BrowserApi } from './browser-types'
import type { Subscribe } from './events'
import type { RunnerApi } from './runner-types'
import type { GraphApi } from './graph-types'
import type { InsightsApi } from './insights-types'
import type { JobsApi } from './jobs-types'
import type { PipelineApi } from './pipeline-types'
import type { QueueApi } from './queue-types'
import type { ReviewApi } from './review-types'
import type { RemoteApi } from './remote-types'
import type { ProfileApi, WorkspaceApi } from './workspace-types'

/**
 * `window.huntgry`, exposed by preload. One member per feature, each typed in
 * `src/shared/<feature>-types.ts` and built in `src/preload/<feature>.ts`.
 */
export interface HuntgryApi {
  workspace: WorkspaceApi
  profile: ProfileApi
  /** The resume-tailor Claude skill: environment checks and tailoring runs. */
  runner: RunnerApi
  /** Generated applications in the workspace: list, tracking, files. */
  applications: ApplicationsApi
  /** Inputs of the knowledge graph beyond the master profile. */
  graph: GraphApi
  /** Job boards: search, saved jobs, add by URL or pasted text. */
  jobs: JobsApi
  /** Gaps job descriptions keep asking for, and Claude-drafted evidence for the master profile. */
  insights: InsightsApi
  /** In-app browser tabs for job postings (pages live in main). */
  browser: BrowserApi
  /** Bulk tailoring: jobs queued from the Jobs page, started a few at a time. */
  queue: QueueApi
  /** Auto-apply: fill a posting's application form in a browser tab (never submits). */
  apply: ApplyApi
  /** Review of unattended results: approve, re-run or discard; standing approvals. */
  review: ReviewApi
  /** Unattended pipeline over the queue: plan, start, pause, resume, stop, state, last summary. */
  pipeline: PipelineApi
  /** Remote control: the relay session, its credentials and paired phones (ADR-0001). */
  remote: RemoteApi
  /** Main → renderer events, restricted to `EVENT_CHANNELS`. */
  on: Subscribe
}
