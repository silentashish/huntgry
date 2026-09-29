import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type ProfileApi, type WorkspaceApi } from '@shared/workspace-types'

export const workspace: WorkspaceApi = {
  pickDirectory: (mode) => ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, mode),
  inspect: (path) => ipcRenderer.invoke(IPC_CHANNELS.inspect, path),
  create: (path, options) => ipcRenderer.invoke(IPC_CHANNELS.create, path, options),
  open: (path) => ipcRenderer.invoke(IPC_CHANNELS.open, path),
  getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.getCurrent)
}

export const profile: ProfileApi = {
  read: () => ipcRenderer.invoke(IPC_CHANNELS.profileRead),
  save: (doc, version) => ipcRenderer.invoke(IPC_CHANNELS.profileSave, doc, version),
  importResume: () => ipcRenderer.invoke(IPC_CHANNELS.profileImportResume),
  openInEditor: () => ipcRenderer.invoke(IPC_CHANNELS.profileOpenInEditor),
  reveal: () => ipcRenderer.invoke(IPC_CHANNELS.profileReveal)
}
