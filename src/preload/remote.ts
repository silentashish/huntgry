import { ipcRenderer } from 'electron'
import { REMOTE_CHANNELS, type RemoteApi } from '@shared/remote-types'

export const remote: RemoteApi = {
  state: () => ipcRenderer.invoke(REMOTE_CHANNELS.state),
  setEnabled: (enabled) => ipcRenderer.invoke(REMOTE_CHANNELS.setEnabled, enabled),
  configure: (input) => ipcRenderer.invoke(REMOTE_CHANNELS.configure, input),
  setNotificationDetails: (on) => ipcRenderer.invoke(REMOTE_CHANNELS.setNotificationDetails, on),
  setTranscripts: (on) => ipcRenderer.invoke(REMOTE_CHANNELS.setTranscripts, on),
  revoke: (deviceId) => ipcRenderer.invoke(REMOTE_CHANNELS.revoke, deviceId),
  unpairAll: () => ipcRenderer.invoke(REMOTE_CHANNELS.unpairAll)
}
