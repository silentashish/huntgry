import { contextBridge } from 'electron'
import type { HuntgryApi } from '@shared/api'
import { on } from './events'
import { graph } from './graph'
import { profile, workspace } from './workspace'

// Sandboxed preload: only `electron` may be required (local modules are bundled
// in). Exposes a fixed set of invoke calls per feature plus allowlisted event
// subscriptions; the renderer never sees ipcRenderer or Node APIs.
const api: HuntgryApi = { workspace, profile, graph, on }

contextBridge.exposeInMainWorld('huntgry', api)
