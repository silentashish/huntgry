import { ipcRenderer } from 'electron'
import { QUEUE_CHANNELS, type QueueApi } from '@shared/queue-types'

export const queue: QueueApi = {
  state: () => ipcRenderer.invoke(QUEUE_CHANNELS.state),
  enqueue: (input) => ipcRenderer.invoke(QUEUE_CHANNELS.enqueue, input),
  cancel: (id) => ipcRenderer.invoke(QUEUE_CHANNELS.cancel, id),
  cancelAll: () => ipcRenderer.invoke(QUEUE_CHANNELS.cancelAll),
  retry: (id) => ipcRenderer.invoke(QUEUE_CHANNELS.retry, id),
  remove: (id) => ipcRenderer.invoke(QUEUE_CHANNELS.remove, id),
  clearFinished: () => ipcRenderer.invoke(QUEUE_CHANNELS.clearFinished),
  setConcurrency: (n) => ipcRenderer.invoke(QUEUE_CHANNELS.setConcurrency, n),
  setPaused: (paused) => ipcRenderer.invoke(QUEUE_CHANNELS.setPaused, paused),
  setAgent: (id, agent) => ipcRenderer.invoke(QUEUE_CHANNELS.setAgent, id, agent)
}
