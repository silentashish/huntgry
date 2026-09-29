import { ipcRenderer } from 'electron'
import { GRAPH_CHANNELS, type GraphApi } from '@shared/graph-types'

export const graph: GraphApi = {
  jobDescriptions: () => ipcRenderer.invoke(GRAPH_CHANNELS.jobDescriptions)
}
