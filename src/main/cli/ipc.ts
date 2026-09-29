import { app, ipcMain, shell } from 'electron'
import { join, resolve, sep } from 'node:path'
import { RUNNER_CHANNELS, type RunSummary } from '@shared/runner-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { buildSystemPrompt, MAX_TEXT, requireStartParams } from './command'
import { buildChildEnv, loginShellPath } from './env'
import { checkEnvironment, discoverRuntime, installPythonDeps } from './environment'
import { RunManager, type RunContext } from './runner'
import { listRuns, OUTPUT_FILES, readEvents, readRun, RUN_ID_PATTERN } from './runs'

/** The venv the skill's `python3` comes from. Shared by every workspace. */
const venvDir = (): string => join(app.getPath('userData'), 'skill-venv')

const manager = new RunManager({
  onEvent: (runId, seq, event) => emit('runner:event', { runId, seq, event }),
  onRun: (run) => emit('runner:run', run)
})

/** Kills every `claude` child; called when the app quits. */
export function stopAllRuns(): void {
  manager.stopAll()
}

function requireRunId(id: unknown): string {
  if (typeof id !== 'string' || !RUN_ID_PATTERN.test(id)) throw new Error('Invalid run id.')
  return id
}

async function context(): Promise<RunContext> {
  const workspace = await requireCurrentWorkspace()
  // File checks only: the full preflight is for Settings and the Tailor form's warning.
  const env = await discoverRuntime()
  if (!env.claudePath) throw new Error('The claude CLI was not found. See Settings.')
  if (!env.skillDir) throw new Error('The resume-tailor skill was not found. See Settings.')
  return {
    workspace: workspace.path,
    skillDir: env.skillDir,
    command: env.claudePath,
    env: buildChildEnv({
      base: process.env,
      workspace: workspace.path,
      venvDir: venvDir(),
      texBin: env.texBin,
      loginPath: await loginShellPath()
    }),
    systemPrompt: buildSystemPrompt({
      workspace: workspace.path,
      masterProfile: workspace.masterProfile,
      skillDir: env.skillDir
    })
  }
}

async function currentRun(id: string): Promise<RunSummary> {
  const workspace = await requireCurrentWorkspace()
  return manager.liveRun(id) ? { ...manager.liveRun(id)!, live: true } : readRun(workspace.path, id)
}

/** Absolute path of one output file of a run, confined to the workspace. */
async function outputPath(id: string, file?: string): Promise<string> {
  const workspace = await requireCurrentWorkspace()
  const run = await currentRun(id)
  if (!run.outputFolder) throw new Error('This run has not produced an application folder yet.')
  const folder = resolve(workspace.path, run.outputFolder)
  if (!folder.startsWith(workspace.path + sep)) throw new Error('The output folder is outside the workspace.')
  if (file === undefined) return folder
  if (!(OUTPUT_FILES as readonly string[]).includes(file)) throw new Error('Unknown output file.')
  return join(folder, file)
}

/** Environment checks and tailoring runs of the resume-tailor skill. */
export function registerRunnerIpc(): void {
  ipcMain.handle(RUNNER_CHANNELS.environment, async () => {
    const workspace = await requireCurrentWorkspace().catch(() => null)
    return checkEnvironment({ venvDir: venvDir(), workspace: workspace?.path ?? null })
  })

  ipcMain.handle(RUNNER_CHANNELS.installPythonDeps, () =>
    installPythonDeps(venvDir(), (line) => emit('runner:install-log', line))
  )

  ipcMain.handle(RUNNER_CHANNELS.listRuns, async () => {
    const workspace = await requireCurrentWorkspace()
    const runs = await listRuns(workspace.path)
    return runs.map((r) => (manager.isLive(r.id) ? { ...manager.liveRun(r.id)!, live: true } : r))
  })

  ipcMain.handle(RUNNER_CHANNELS.getRun, async (_e, id: unknown) => {
    const runId = requireRunId(id)
    const workspace = await requireCurrentWorkspace()
    await manager.flush(runId)
    return { run: await currentRun(runId), events: await readEvents(workspace.path, runId) }
  })

  ipcMain.handle(RUNNER_CHANNELS.start, async (_e, params: unknown) =>
    manager.start(requireStartParams(params), await context())
  )

  ipcMain.handle(RUNNER_CHANNELS.reply, async (_e, id: unknown, text: unknown) => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('Type a reply first.')
    return manager.reply(requireRunId(id), text, context)
  })

  ipcMain.handle(RUNNER_CHANNELS.stop, async (_e, id: unknown) => {
    const runId = requireRunId(id)
    manager.stop(runId)
    return currentRun(runId)
  })

  ipcMain.handle(RUNNER_CHANNELS.finish, async (_e, id: unknown) => {
    const runId = requireRunId(id)
    manager.finish(runId)
    return currentRun(runId)
  })

  ipcMain.handle(RUNNER_CHANNELS.openOutput, async (_e, id: unknown, file: unknown) => {
    if (typeof file !== 'string') throw new Error('Unknown output file.')
    const error = await shell.openPath(await outputPath(requireRunId(id), file))
    if (error) throw new Error(error)
  })

  ipcMain.handle(RUNNER_CHANNELS.revealOutput, async (_e, id: unknown) => {
    const runId = requireRunId(id)
    const run = await currentRun(runId)
    // Select a file that exists (resume.pdf when built, else whatever the skill wrote), else open the folder.
    const file = run.outputFiles.includes('resume.pdf') ? 'resume.pdf' : run.outputFiles[0]
    if (file) shell.showItemInFolder(await outputPath(runId, file))
    else await shell.openPath(await outputPath(runId))
  })
}
