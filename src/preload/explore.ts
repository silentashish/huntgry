import { ipcRenderer } from 'electron'
import { EXPLORE_CHANNELS, type ExploreApi } from '@shared/explore-types'

export const explore: ExploreApi = {
  list: (category) => ipcRenderer.invoke(EXPLORE_CHANNELS.list, category),
  refresh: (category) => ipcRenderer.invoke(EXPLORE_CHANNELS.refresh, category),
  add: (id, category) => ipcRenderer.invoke(EXPLORE_CHANNELS.add, id, category),
  account: () => ipcRenderer.invoke(EXPLORE_CHANNELS.account),
  connect: () => ipcRenderer.invoke(EXPLORE_CHANNELS.connect),
  checkAccount: () => ipcRenderer.invoke(EXPLORE_CHANNELS.checkAccount),
  disconnect: () => ipcRenderer.invoke(EXPLORE_CHANNELS.disconnect)
}
