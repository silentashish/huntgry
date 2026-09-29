import { registerGraphIpc } from './graph/ipc'
import { registerProfileIpc } from './profile/ipc'
import { registerWorkspaceIpc } from './workspace/ipc'

/**
 * The only bridge between the renderer and the filesystem. Each feature owns
 * its handlers in `src/main/<feature>/ipc.ts`; add one line here per feature.
 */
export function registerIpcHandlers(): void {
  registerWorkspaceIpc()
  registerProfileIpc()
  registerGraphIpc()
}
