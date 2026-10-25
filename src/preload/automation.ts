import { ipcRenderer } from 'electron'
import { AUTOMATION_CHANNELS, type AutomationApi } from '@shared/automation-types'

export const automation: AutomationApi = {
  state: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.state),
  settings: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.settings),
  updateSettings: (patch) => ipcRenderer.invoke(AUTOMATION_CHANNELS.updateSettings, patch),
  setEnabled: (on) => ipcRenderer.invoke(AUTOMATION_CHANNELS.setEnabled, on),
  pause: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.pause),
  resume: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.resume),
  runNow: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.runNow),
  stop: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.stop),
  preview: () => ipcRenderer.invoke(AUTOMATION_CHANNELS.preview),
  retry: (key) => ipcRenderer.invoke(AUTOMATION_CHANNELS.retry, key),
  dismiss: (key) => ipcRenderer.invoke(AUTOMATION_CHANNELS.dismiss, key),
  log: (options) => ipcRenderer.invoke(AUTOMATION_CHANNELS.log, options),
  prepared: (key) => ipcRenderer.invoke(AUTOMATION_CHANNELS.prepared, key),
  openPrepared: (key) => ipcRenderer.invoke(AUTOMATION_CHANNELS.openPrepared, key)
}
