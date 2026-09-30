import { registerApplicationsIpc } from './applications/ipc'
import { registerBrowserIpc } from './browser/ipc'
import { registerRunnerIpc } from './cli/ipc'
import { registerGraphIpc } from './graph/ipc'
import { registerInsightsIpc } from './insights/ipc'
import { registerJobsIpc } from './jobs/ipc'
import { registerProfileIpc } from './profile/ipc'
import { registerWorkspaceIpc } from './workspace/ipc'

/**
 * The only bridge between the renderer and the filesystem. Each feature owns
 * its handlers in `src/main/<feature>/ipc.ts`; add one line here per feature.
 */
export function registerIpcHandlers(): void {
  registerWorkspaceIpc()
  registerProfileIpc()
  registerApplicationsIpc()
  registerRunnerIpc()
  registerGraphIpc()
  registerJobsIpc()
  registerInsightsIpc()
  registerBrowserIpc()
}
