import { ipcRenderer } from 'electron'
import { INSIGHTS_CHANNELS, type InsightsApi } from '@shared/insights-types'

export const insights: InsightsApi = {
  get: () => ipcRenderer.invoke(INSIGHTS_CHANNELS.get),
  dismiss: (key, skill) => ipcRenderer.invoke(INSIGHTS_CHANNELS.dismiss, key, skill),
  restore: (key) => ipcRenderer.invoke(INSIGHTS_CHANNELS.restore, key),
  draft: (request) => ipcRenderer.invoke(INSIGHTS_CHANNELS.draft, request)
}
