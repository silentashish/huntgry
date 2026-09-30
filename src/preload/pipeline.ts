import { ipcRenderer } from 'electron'
import { PIPELINE_CHANNELS, type PipelineApi } from '@shared/pipeline-types'

export const pipeline: PipelineApi = {
  plan: (input) => ipcRenderer.invoke(PIPELINE_CHANNELS.plan, input),
  start: (input) => ipcRenderer.invoke(PIPELINE_CHANNELS.start, input),
  pause: () => ipcRenderer.invoke(PIPELINE_CHANNELS.pause),
  resume: (options) => ipcRenderer.invoke(PIPELINE_CHANNELS.resume, options),
  stop: () => ipcRenderer.invoke(PIPELINE_CHANNELS.stop),
  state: () => ipcRenderer.invoke(PIPELINE_CHANNELS.state),
  lastSummary: () => ipcRenderer.invoke(PIPELINE_CHANNELS.lastSummary),
  dismiss: () => ipcRenderer.invoke(PIPELINE_CHANNELS.dismiss)
}
