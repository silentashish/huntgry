import { contextBridge } from 'electron'
import type { HuntgryApi } from '@shared/api'
import { applications } from './applications'
import { browser } from './browser'
import { on } from './events'
import { graph } from './graph'
import { insights } from './insights'
import { runner } from './runner'
import { jobs } from './jobs'
import { queue } from './queue'
import { profile, workspace } from './workspace'

// Sandboxed preload: only `electron` may be required (local modules are bundled
// in). Exposes a fixed set of invoke calls per feature plus allowlisted event
// subscriptions; the renderer never sees ipcRenderer or Node APIs.
const api: HuntgryApi = { workspace, profile, runner, applications, graph, jobs, insights, browser, queue, on }

contextBridge.exposeInMainWorld('huntgry', api)
