import { ipcRenderer } from 'electron'
import { APPLY_CHANNELS, type ApplyApi } from '@shared/apply-types'

export const apply: ApplyApi = {
  start: (applicationId) => ipcRenderer.invoke(APPLY_CHANNELS.start, applicationId),
  fill: (sessionId) => ipcRenderer.invoke(APPLY_CHANNELS.fill, sessionId),
  cancel: (sessionId) => ipcRenderer.invoke(APPLY_CHANNELS.cancel, sessionId),
  current: () => ipcRenderer.invoke(APPLY_CHANNELS.current)
}
