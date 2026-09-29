import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type HuntgryApi } from '@shared/workspace-types'

// Sandboxed preload: only `electron` may be required. Exposes a fixed set of
// invoke calls; the renderer never sees ipcRenderer or Node APIs.
const api: HuntgryApi = {
  workspace: {
    pickDirectory: (mode) => ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, mode),
    inspect: (path) => ipcRenderer.invoke(IPC_CHANNELS.inspect, path),
    create: (path) => ipcRenderer.invoke(IPC_CHANNELS.create, path),
    open: (path) => ipcRenderer.invoke(IPC_CHANNELS.open, path),
    getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.getCurrent)
  }
}

contextBridge.exposeInMainWorld('huntgry', api)
