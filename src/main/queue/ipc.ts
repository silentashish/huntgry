import { ipcMain } from 'electron'
import { QUEUE_CHANNELS } from '@shared/queue-types'
import { onRunChange, manager, startTailorRun } from '../cli/start'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { fetchDetails, updateJob } from '../jobs/service'
import { loadAndExtract } from '../jobs/loader'
import { findCanonical } from '../jobs/store'
import { requireConcurrency, requireEnqueueInput, requireItemId, TailorQueue } from './queue'

const queue = new TailorQueue({
  workspace: async () => (await requireCurrentWorkspace()).path,
  findJob: findCanonical,
  fetchDetails: (ws, id) => fetchDetails(ws, id, loadAndExtract),
  markTailored: (ws, id) => updateJob(ws, id, { tailored: true }),
  // #22 picks the agent here; only Claude exists today.
  start: (params) => startTailorRun(params),
  stopRun: (runId) => manager.stop(runId),
  onChange: (state) => emit('queue:changed', state)
})
onRunChange((run) => queue.onRun(run))

/** Saves the queue as it is before the app stops the runs on quit (they reload as failed-retryable). */
export function stopQueue(): Promise<void> {
  return queue.shutdown()
}

/** Bulk tailoring: jobs queued from the Jobs page, started a few at a time. */
export function registerQueueIpc(): void {
  ipcMain.handle(QUEUE_CHANNELS.state, () => queue.sync())
  ipcMain.handle(QUEUE_CHANNELS.enqueue, (_e, input: unknown) => queue.enqueue(requireEnqueueInput(input)))
  ipcMain.handle(QUEUE_CHANNELS.cancel, (_e, id: unknown) => queue.cancel(requireItemId(id)))
  ipcMain.handle(QUEUE_CHANNELS.cancelAll, () => queue.cancelAll())
  ipcMain.handle(QUEUE_CHANNELS.retry, (_e, id: unknown) => queue.retry(requireItemId(id)))
  ipcMain.handle(QUEUE_CHANNELS.remove, (_e, id: unknown) => queue.remove(requireItemId(id)))
  ipcMain.handle(QUEUE_CHANNELS.clearFinished, () => queue.clearFinished())
  ipcMain.handle(QUEUE_CHANNELS.setConcurrency, (_e, n: unknown) => queue.setConcurrency(requireConcurrency(n)))
  ipcMain.handle(QUEUE_CHANNELS.setPaused, (_e, paused: unknown) => {
    if (typeof paused !== 'boolean') throw new Error('Invalid pause state.')
    return queue.setPaused(paused)
  })
}
