import { ipcMain } from 'electron'
import { JOB_ID_PATTERN, JOBS_CHANNELS } from '@shared/jobs-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { loadAndExtract } from './loader'
import { addByUrl, addPasted, fetchDetails, listJobs, searchJobs, updateJob, validateQuery } from './service'
import { recentSearches } from './store'

const workspace = async () => (await requireCurrentWorkspace()).path

function requireJobId(id: unknown): string {
  if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) throw new Error('Invalid job id.')
  return id
}

/** Job boards: on-demand search, saved jobs, add by URL or pasted text. */
export function registerJobsIpc(): void {
  ipcMain.handle(JOBS_CHANNELS.list, async () => listJobs(await workspace()))
  ipcMain.handle(JOBS_CHANNELS.search, async (_e, q: unknown) =>
    searchJobs(await workspace(), validateQuery(q), loadAndExtract)
  )
  ipcMain.handle(JOBS_CHANNELS.fetchDetails, async (_e, id: unknown) =>
    fetchDetails(await workspace(), requireJobId(id), loadAndExtract)
  )
  ipcMain.handle(JOBS_CHANNELS.addByUrl, async (_e, url: unknown) => {
    if (typeof url !== 'string' || url.length > 2000) throw new Error('Enter a job posting URL.')
    return addByUrl(await workspace(), url.trim(), loadAndExtract)
  })
  ipcMain.handle(JOBS_CHANNELS.addPasted, async (_e, input: unknown) => addPasted(await workspace(), input))
  ipcMain.handle(JOBS_CHANNELS.update, async (_e, id: unknown, patch: unknown) => {
    const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>
    return updateJob(await workspace(), requireJobId(id), {
      dismissed: typeof p.dismissed === 'boolean' ? p.dismissed : undefined,
      tailored: p.tailored === true
    })
  })
  ipcMain.handle(JOBS_CHANNELS.recentSearches, async () => recentSearches(await workspace()))
}
