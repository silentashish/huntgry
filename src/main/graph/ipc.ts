import { ipcMain } from 'electron'
import { GRAPH_CHANNELS } from '@shared/graph-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { readJobDescriptions } from './jobs'

/** Inputs of the knowledge graph beyond the master profile. */
export function registerGraphIpc(): void {
  ipcMain.handle(GRAPH_CHANNELS.jobDescriptions, async () =>
    readJobDescriptions((await requireCurrentWorkspace()).path)
  )
}
