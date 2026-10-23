import { BrowserWindow, ipcMain } from 'electron'
import { EXPLORE_CHANNELS, JOBRIGHT_ID_PATTERN } from '@shared/explore-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { checkJobrightAccount, connectJobright, disconnectJobright, jobrightAccount } from './account'
import { exploreDeps as deps } from './deps'
import { addExplore, listExplore, refreshExplore } from './service'

const workspace = async () => (await requireCurrentWorkspace()).path

/** Explore (#142): Jobright's new-grad list, cached per workspace; rows are added to the Jobs page by id. */
export function registerExploreIpc(): void {
  ipcMain.handle(EXPLORE_CHANNELS.list, async () => listExplore(await workspace(), deps()))
  ipcMain.handle(EXPLORE_CHANNELS.refresh, async () => refreshExplore(await workspace(), deps()))
  ipcMain.handle(EXPLORE_CHANNELS.add, async (_e, id: unknown) => {
    if (typeof id !== 'string' || !JOBRIGHT_ID_PATTERN.test(id)) throw new Error('Invalid job id.')
    return addExplore(await workspace(), id, deps())
  })
  // Settings → Jobright (#146): the hidden job-board browser's sign-in.
  ipcMain.handle(EXPLORE_CHANNELS.account, () => jobrightAccount())
  ipcMain.handle(EXPLORE_CHANNELS.connect, (e) => connectJobright(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(EXPLORE_CHANNELS.checkAccount, () => checkJobrightAccount())
  ipcMain.handle(EXPLORE_CHANNELS.disconnect, () => disconnectJobright())
}
