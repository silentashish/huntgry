import { BrowserWindow, ipcMain } from 'electron'
import { DEFAULT_EXPLORE_CATEGORY, EXPLORE_CHANNELS, isExploreCategory, JOBRIGHT_ID_PATTERN } from '@shared/explore-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { checkJobrightAccount, connectJobright, disconnectJobright, jobrightAccount } from './account'
import { exploreDeps as deps } from './deps'
import { addExplore, listExplore, refreshExplore } from './service'

const workspace = async () => (await requireCurrentWorkspace()).path

/** The renderer's category, when it is one the picker offers; else the default. */
const categoryOf = (c: unknown): string => (isExploreCategory(c) ? c : DEFAULT_EXPLORE_CATEGORY)

/** Explore (#142, #169): Jobright's jobs per category, cached per workspace; rows are added to the Jobs page by id. */
export function registerExploreIpc(): void {
  ipcMain.handle(EXPLORE_CHANNELS.list, async (_e, category: unknown) => listExplore(await workspace(), categoryOf(category), deps()))
  ipcMain.handle(EXPLORE_CHANNELS.refresh, async (_e, category: unknown) => refreshExplore(await workspace(), categoryOf(category), deps()))
  ipcMain.handle(EXPLORE_CHANNELS.add, async (_e, id: unknown, category: unknown) => {
    if (typeof id !== 'string' || !JOBRIGHT_ID_PATTERN.test(id)) throw new Error('Invalid job id.')
    return addExplore(await workspace(), id, categoryOf(category), deps())
  })
  // Settings → Jobright (#146): the hidden job-board browser's sign-in.
  ipcMain.handle(EXPLORE_CHANNELS.account, () => jobrightAccount())
  ipcMain.handle(EXPLORE_CHANNELS.connect, (e) => connectJobright(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(EXPLORE_CHANNELS.checkAccount, () => checkJobrightAccount())
  ipcMain.handle(EXPLORE_CHANNELS.disconnect, () => disconnectJobright())
}
