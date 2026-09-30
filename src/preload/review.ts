import { ipcRenderer } from 'electron'
import { REVIEW_CHANNELS, type ReviewApi } from '@shared/review-types'

export const review: ReviewApi = {
  list: () => ipcRenderer.invoke(REVIEW_CHANNELS.list),
  get: (id) => ipcRenderer.invoke(REVIEW_CHANNELS.get, id),
  approve: (input) => ipcRenderer.invoke(REVIEW_CHANNELS.approve, input),
  rerun: (input) => ipcRenderer.invoke(REVIEW_CHANNELS.rerun, input),
  discard: (input) => ipcRenderer.invoke(REVIEW_CHANNELS.discard, input),
  approvals: () => ipcRenderer.invoke(REVIEW_CHANNELS.approvals),
  removeApproval: (id) => ipcRenderer.invoke(REVIEW_CHANNELS.removeApproval, id),
  removeAllApprovals: () => ipcRenderer.invoke(REVIEW_CHANNELS.removeAllApprovals)
}
