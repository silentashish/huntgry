import { app, ipcMain } from 'electron'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { PIPELINE_CHANNELS } from '@shared/pipeline-types'
import { scanApplications } from '../applications/scan'
import { skillStatus } from '../cli/agents/skills'
import { findCli, findSkillDir, findTexBin, loginShellPath, buildChildEnv } from '../cli/env'
import { checkEnvironment } from '../cli/environment'
import { listRuns, medianRunDuration } from '../cli/runs'
import { defaultAgent, manager, onRunChange, venvDir } from '../cli/start'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { fetchDetails } from '../jobs/service'
import { loadAndExtract } from '../jobs/loader'
import { findCanonical } from '../jobs/store'
import { queue } from '../queue/ipc'
import { notify, setBadge } from './notify'
import { Pipeline } from './pipeline'
import { isOnBattery, keepAwake, watchPower } from './power'
import { requirePipelineStartInput, requireResumeOptions } from './service'
import { runVerify } from './verify'
import { homedir } from 'node:os'

const workspace = async () => (await requireCurrentWorkspace()).path

/** Median cost of the last finished unattended Claude runs (the plan's cost estimate). */
async function medianCost(ws: string): Promise<number | null> {
  const costs = (await listRuns(ws))
    .filter((r) => r.status === 'finished' && r.unattended && r.agent === 'claude' && r.costUsd > 0)
    .slice(0, 20)
    .map((r) => r.costUsd)
    .sort((a, b) => a - b)
  if (costs.length === 0) return null
  const mid = Math.floor(costs.length / 2)
  return costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2
}

/** The app's one pipeline (the service API #41's gateway will call). */
export const pipeline = new Pipeline({
  queue,
  workspace,
  findJob: findCanonical,
  fetchDetails: (ws, id) => fetchDetails(ws, id, loadAndExtract),
  tailoredJobIds: async (ws) => new Set((await scanApplications(ws)).applications.map((a) => a.jobId)),
  environment: async () => {
    const env = await checkEnvironment({ venvDir: venvDir(), workspace: await workspace().catch(() => null), defaultAgent: await defaultAgent() })
    return { agents: env.agents.map((a) => ({ id: a.id, ready: a.ready, problems: a.problems })), sharedProblems: env.sharedProblems }
  },
  freeDiskBytes: async (ws) => {
    try {
      const s = await statfs(ws)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      return null
    }
  },
  runHistory: async (ws) => ({ medianMs: await medianRunDuration(ws, { unattended: true }), medianCostUsd: await medianCost(ws) }),
  verify: async (ws, folder) => {
    const [skillDir, texBin, loginPath] = await Promise.all([findSkillDir(), findTexBin(), loginShellPath()])
    const env = buildChildEnv({ base: process.env, workspace: ws, venvDir: venvDir(), texBin, loginPath })
    return runVerify({ skillDir, venvDir: venvDir(), folder: join(ws, folder), env })
  },
  liveRun: (runId) => manager.liveRun(runId),
  abort: (runId, reason) => manager.abort(runId, reason),
  notify,
  setBadge,
  keepAwake,
  onBattery: isOnBattery,
  emit: (state) => emit('pipeline:changed', state),
  emitFinished: (summary) => emit('pipeline:finished', summary)
})
onRunChange((run) => pipeline.onRun(run))

/** Quick readiness check of an agent's CLI and skill (used by the fallback switch and the modal). */
export async function agentReady(agent: Parameters<typeof skillStatus>[0]): Promise<boolean> {
  const [cli, skill] = await Promise.all([findCli(agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'agy'), skillStatus(agent, homedir())])
  return !!cli && !!skill.path
}

/** After the window and IPC are up: resume a pipeline interrupted by a restart, watch sleep/wake and power. */
export function initPipeline(): void {
  watchPower({
    onResume: () => pipeline.wake(),
    onPowerChange: () => pipeline.powerChanged(),
    onShutdown: () => void queue.flush()
  })
  void pipeline.init(app.isPackaged ? 5000 : 2000).catch((err: unknown) => console.error('Pipeline init failed:', err))
}

/** Before quit: release keep-awake (the queue saves itself first). */
export function stopPipeline(): Promise<void> {
  return pipeline.shutdown()
}

export function registerPipelineIpc(): void {
  ipcMain.handle(PIPELINE_CHANNELS.plan, async (_e, input: unknown) => pipeline.plan(requirePipelineStartInput(input, await defaultAgent())))
  ipcMain.handle(PIPELINE_CHANNELS.start, async (_e, input: unknown) => pipeline.start(requirePipelineStartInput(input, await defaultAgent())))
  ipcMain.handle(PIPELINE_CHANNELS.pause, () => pipeline.pause())
  ipcMain.handle(PIPELINE_CHANNELS.resume, (_e, options: unknown) => pipeline.resume(requireResumeOptions(options)))
  ipcMain.handle(PIPELINE_CHANNELS.stop, () => pipeline.stop())
  ipcMain.handle(PIPELINE_CHANNELS.state, async () => {
    await queue.sync()
    return pipeline.state()
  })
  ipcMain.handle(PIPELINE_CHANNELS.lastSummary, () => pipeline.lastSummary())
  ipcMain.handle(PIPELINE_CHANNELS.dismiss, () => pipeline.dismiss())
}
