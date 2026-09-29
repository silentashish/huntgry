import { ipcRenderer } from 'electron'
import { APPLICATIONS_CHANNELS, applicationFileUrl, type ApplicationsApi } from '@shared/applications-types'

export const applications: ApplicationsApi = {
  list: () => ipcRenderer.invoke(APPLICATIONS_CHANNELS.list),
  updateTracking: (id, patch) => ipcRenderer.invoke(APPLICATIONS_CHANNELS.updateTracking, id, patch),
  readJobDescription: (id) => ipcRenderer.invoke(APPLICATIONS_CHANNELS.readJobDescription, id),
  openFile: (id, file) => ipcRenderer.invoke(APPLICATIONS_CHANNELS.openFile, id, file),
  reveal: (id) => ipcRenderer.invoke(APPLICATIONS_CHANNELS.reveal, id),
  fileUrl: (id, file) => applicationFileUrl(id, file)
}
