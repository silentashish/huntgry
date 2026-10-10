import { ipcRenderer } from 'electron'
import { REMOTE_CHANNELS, type RemoteApi } from '@shared/remote-types'

export const remote: RemoteApi = {
  state: () => ipcRenderer.invoke(REMOTE_CHANNELS.state),
  setEnabled: (enabled) => ipcRenderer.invoke(REMOTE_CHANNELS.setEnabled, enabled),
  configure: (input) => ipcRenderer.invoke(REMOTE_CHANNELS.configure, input),
  rotate: () => ipcRenderer.invoke(REMOTE_CHANNELS.rotate),
  setNotificationDetails: (on) => ipcRenderer.invoke(REMOTE_CHANNELS.setNotificationDetails, on),
  setTranscripts: (on) => ipcRenderer.invoke(REMOTE_CHANNELS.setTranscripts, on),
  setCommandTtl: (input) => ipcRenderer.invoke(REMOTE_CHANNELS.setCommandTtl, input),
  revoke: (deviceId) => ipcRenderer.invoke(REMOTE_CHANNELS.revoke, deviceId),
  unpairAll: () => ipcRenderer.invoke(REMOTE_CHANNELS.unpairAll),
  startPairing: () => ipcRenderer.invoke(REMOTE_CHANNELS.startPairing),
  cancelPairing: (pairingId) => ipcRenderer.invoke(REMOTE_CHANNELS.cancelPairing, pairingId),
  approvePairing: (pairingId) => ipcRenderer.invoke(REMOTE_CHANNELS.approvePairing, pairingId),
  denyPairing: (pairingId) => ipcRenderer.invoke(REMOTE_CHANNELS.denyPairing, pairingId),
  audit: () => ipcRenderer.invoke(REMOTE_CHANNELS.audit)
}
