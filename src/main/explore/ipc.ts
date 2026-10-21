import { app, ipcMain } from 'electron'
import { EXPLORE_CHANNELS, JOBRIGHT_ID_PATTERN } from '@shared/explore-types'
import { refusalFor } from '../browser/url'
import { localUrlsAllowed, loopbackOnly } from '../cli/dev-urls'
import { requireCurrentWorkspace } from '../current-workspace'
import { addExplore, fetchReadme, listExplore, refreshExplore, type ExploreDeps } from './service'
import { exploreSource } from './source'

const workspace = async () => (await requireCurrentWorkspace()).path

function deps(): ExploreDeps {
  return {
    ...exploreSource(app.isPackaged),
    fetchText: (url) => fetchReadme(url),
    // The same guard as the in-app browser and the posting loader: public hosts only (loopback only in a
    // dev build with the mock-server allowance, and nothing but loopback under the e2e harness).
    refusal: (url) => refusalFor(url, undefined, localUrlsAllowed(app.isPackaged), loopbackOnly(app.isPackaged))
  }
}

/** Explore (#142): Jobright's new-grad list, cached per workspace; rows are added to the Jobs page by id. */
export function registerExploreIpc(): void {
  ipcMain.handle(EXPLORE_CHANNELS.list, async () => listExplore(await workspace(), deps()))
  ipcMain.handle(EXPLORE_CHANNELS.refresh, async () => refreshExplore(await workspace(), deps()))
  ipcMain.handle(EXPLORE_CHANNELS.add, async (_e, id: unknown) => {
    if (typeof id !== 'string' || !JOBRIGHT_ID_PATTERN.test(id)) throw new Error('Invalid job id.')
    return addExplore(await workspace(), id, deps())
  })
}
