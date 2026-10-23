import { ipcRenderer } from 'electron'
import { EXPLORE_CHANNELS, type ExploreApi } from '@shared/explore-types'

export const explore: ExploreApi = {
  list: () => ipcRenderer.invoke(EXPLORE_CHANNELS.list),
  refresh: () => ipcRenderer.invoke(EXPLORE_CHANNELS.refresh),
  add: (id) => ipcRenderer.invoke(EXPLORE_CHANNELS.add, id),
  account: () => ipcRenderer.invoke(EXPLORE_CHANNELS.account),
  connect: () => ipcRenderer.invoke(EXPLORE_CHANNELS.connect),
  checkAccount: () => ipcRenderer.invoke(EXPLORE_CHANNELS.checkAccount),
  disconnect: () => ipcRenderer.invoke(EXPLORE_CHANNELS.disconnect)
}
