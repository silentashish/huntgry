import { ipcRenderer } from 'electron'
import { REVIEW_CHANNELS, type ReviewApi } from '@shared/review-types'

export const review: ReviewApi = {
  list: () => ipcRenderer.invoke(REVIEW_CHANNELS.list),
  get: (id) => ipcRenderer.invoke(REVIEW_CHANNELS.get, id),
  approve: (input) => ipcRenderer.invoke(REVIEW_CHANNELS.approve, input),
  rerun: (input) => ipcRenderer.invoke(REVIEW_CHANNELS.rerun, input),
  discard: (input) => ipcRenderer.invoke(REVIEW_CHANNELS.discard, input),
  reject: (input) => ipcRenderer.invoke(REVIEW_CHANNELS.reject, input),
  rules: () => ipcRenderer.invoke(REVIEW_CHANNELS.rules),
  removeRule: (id) => ipcRenderer.invoke(REVIEW_CHANNELS.removeRule, id),
  removeAllRules: () => ipcRenderer.invoke(REVIEW_CHANNELS.removeAllRules)
}
