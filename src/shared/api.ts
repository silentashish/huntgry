import type { ApplicationsApi } from './applications-types'
import type { Subscribe } from './events'
import type { RunnerApi } from './runner-types'
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
  /** Main → renderer events, restricted to `EVENT_CHANNELS`. */
  on: Subscribe
}
