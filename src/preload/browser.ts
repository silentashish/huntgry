import { ipcRenderer } from 'electron'
import { BROWSER_CHANNELS, type BrowserApi } from '@shared/browser-types'

export const browser: BrowserApi = {
  state: () => ipcRenderer.invoke(BROWSER_CHANNELS.state),
  open: (url, opts) => ipcRenderer.invoke(BROWSER_CHANNELS.open, url, opts),
  close: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.close, id),
  activate: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.activate, id),
  navigate: (id, input) => ipcRenderer.invoke(BROWSER_CHANNELS.navigate, id, input),
  back: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.back, id),
  forward: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.forward, id),
  reload: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.reload, id),
  stop: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.stop, id),
  openExternal: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.openExternal, id),
  setBounds: (rect) => ipcRenderer.invoke(BROWSER_CHANNELS.setBounds, rect),
  setVisible: (visible) => ipcRenderer.invoke(BROWSER_CHANNELS.setVisible, visible)
}
