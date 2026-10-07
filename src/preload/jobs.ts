import { ipcRenderer } from 'electron'
import { JOBS_CHANNELS, type JobsApi } from '@shared/jobs-types'

export const jobs: JobsApi = {
  list: () => ipcRenderer.invoke(JOBS_CHANNELS.list),
  fetchDetails: (id) => ipcRenderer.invoke(JOBS_CHANNELS.fetchDetails, id),
  addByUrl: (url) => ipcRenderer.invoke(JOBS_CHANNELS.addByUrl, url),
  addPasted: (input) => ipcRenderer.invoke(JOBS_CHANNELS.addPasted, input),
  update: (id, patch) => ipcRenderer.invoke(JOBS_CHANNELS.update, id, patch),
  prefs: () => ipcRenderer.invoke(JOBS_CHANNELS.prefs),
  setPrefs: (patch) => ipcRenderer.invoke(JOBS_CHANNELS.setPrefs, patch)
}
