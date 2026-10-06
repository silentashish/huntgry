import { app, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isAgentId, RUNNER_CHANNELS, type AgentId, type RunSummary, type TranscriptItem } from '@shared/runner-types'
import { buildTranscript } from '@shared/transcript'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { MAX_TEXT } from './command'
import { installAgentSkill } from './agents/skills'
import { findClaude, findSkillDir } from './env'
import { checkEnvironment, installPythonDeps } from './environment'
import { claudeInstallKind, exclusive, installClaude, updateClaude } from './install-claude'
import { installSkill } from './install-skill'
import { listRuns, OUTPUT_FILES, readEvents, readRun, requireRunId } from './runs'
import { replyThroughQueue } from '../queue/ipc'
import { WorkspaceChangedError } from '../workspace/changed'
import { contextForRun, defaultAgent, manager, setDefaultAgent, startTailorRun, venvDir } from './start'

/** Which skill release Huntgry installed (see `install-skill.ts`). */
const skillRecordPath = (): string => join(app.getPath('userData'), 'skill-install.json')
const installLog = (line: string): void => emit('runner:install-log', line)

export { stopAllRuns } from './start'

function requireAgent(agent: unknown): AgentId {
  if (!isAgentId(agent)) throw new Error('Unknown agent.')
  return agent
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

/**
 * A run of `workspace` (live or on disk). A live run started in another workspace is not this
 * workspace's run, whatever its id: `WorkspaceChangedError`.
 */
async function runIn(workspace: string, id: string): Promise<RunSummary> {
  const live = manager.liveRun(id)
  if (!live) return readRun(workspace, id)
  if (manager.liveWorkspace(id) !== workspace) throw new WorkspaceChangedError()
  return { ...live, live: true }
}

/**
 * Runs for the remote gateway (ADR-0001): the same helpers and rules as the handlers below,
 * minus open / reveal. Every call takes the workspace the gateway checked and never resolves
 * the open one again, so a switch while the command waited cannot redirect it.
 */
export const runsForRemote = {
  list: async (workspace: string): Promise<RunSummary[]> => {
    const runs = await listRuns(workspace)
    return runs.map((r) => (manager.isLive(r.id) && manager.liveWorkspace(r.id) === workspace ? { ...manager.liveRun(r.id)!, live: true } : r))
  },
  get: async (workspace: string, runId: string): Promise<{ run: RunSummary; items: TranscriptItem[] }> => {
    await manager.flush(runId)
    const run = await runIn(workspace, runId)
    return { run, items: buildTranscript(await readEvents(workspace, runId), run.agent) }
  },
  reply: async (workspace: string, runId: string, text: string): Promise<RunSummary> => {
    const run = await runIn(workspace, runId)
    // Same rule as RUNNER_CHANNELS.reply (the gateway checks it first): an unattended run continues only through the queue.
    if (run.unattended || run.params.unattended) throw new Error('This unattended run cannot be continued now. Try again in a moment.')
    // A run with no process resumes in a context built for `workspace`; `context` refuses another open one.
    return manager.reply(runId, text, () => contextForRun(runId, workspace))
  },
  stop: async (workspace: string, runId: string): Promise<RunSummary> => {
    await runIn(workspace, runId)
    manager.stop(runId)
    return runIn(workspace, runId)
  },
  finish: async (workspace: string, runId: string): Promise<RunSummary> => {
    await runIn(workspace, runId)
    if (manager.isLive(runId)) {
      manager.finish(runId)
      return runIn(workspace, runId)
    }
    return (await manager.endIdle(workspace, runId, 'finished')) ?? runIn(workspace, runId)
  }
}

/** Environment checks and tailoring runs of the resume-tailor skill. */
export function registerRunnerIpc(): void {
  ipcMain.handle(RUNNER_CHANNELS.environment, async () => {
    const workspace = await requireCurrentWorkspace().catch(() => null)
    return checkEnvironment({
      venvDir: venvDir(),
      workspace: workspace?.path ?? null,
      skillRecordPath: skillRecordPath(),
      defaultAgent: await defaultAgent()
    })
  })

  ipcMain.handle(RUNNER_CHANNELS.setDefaultAgent, (_e, agent: unknown) => setDefaultAgent(requireAgent(agent)))

  ipcMain.handle(RUNNER_CHANNELS.linkSkill, async (_e, agent: unknown) =>
    installAgentSkill(requireAgent(agent), await findSkillDir(), homedir())
  )

  ipcMain.handle(RUNNER_CHANNELS.installPythonDeps, () => installPythonDeps(venvDir(), installLog))

  ipcMain.handle(RUNNER_CHANNELS.installClaude, async () => {
    if (await findClaude()) return { ok: false, error: 'Claude Code is already installed. Use Update instead.' }
    return installClaude(installLog, { scratchDir: app.getPath('userData') })
  })

  ipcMain.handle(RUNNER_CHANNELS.updateClaude, async () => {
    const claudePath = await findClaude()
    if (!claudePath) return { ok: false, error: 'The claude CLI was not found. Install it first.' }
    return updateClaude(installLog, {
      claudePath,
      kind: await claudeInstallKind(claudePath),
      scratchDir: app.getPath('userData')
    })
  })

  ipcMain.handle(RUNNER_CHANNELS.installSkill, (_e, replace: unknown) =>
    exclusive(installLog, () =>
      installSkill(installLog, {
        home: homedir(),
        recordPath: skillRecordPath(),
        backupDir: join(app.getPath('userData'), 'skill-backups'),
        replace: replace === true
      })
    )
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

  ipcMain.handle(RUNNER_CHANNELS.start, (_e, input: unknown) => startTailorRun(input))

  ipcMain.handle(RUNNER_CHANNELS.reply, async (_e, id: unknown, text: unknown) => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('Type a reply first.')
    const runId = requireRunId(id)
    // A bulk run's reply may have to wait for a free slot (the queue's concurrency).
    const viaQueue = await replyThroughQueue(runId, text)
    if (viaQueue === 'held') return currentRun(runId)
    if (viaQueue) return viaQueue
    // An unattended run continues only through the queue (process cap, pipeline policy, verify gate).
    const run = await currentRun(runId)
    if (run.unattended || run.params.unattended) throw new Error('This unattended run cannot be continued now. Try again in a moment.')
    return manager.reply(runId, text, () => contextForRun(runId))
  })

  ipcMain.handle(RUNNER_CHANNELS.stop, async (_e, id: unknown) => {
    const runId = requireRunId(id)
    manager.stop(runId)
    return currentRun(runId)
  })

  ipcMain.handle(RUNNER_CHANNELS.finish, async (_e, id: unknown) => {
    const runId = requireRunId(id)
    if (manager.isLive(runId)) {
      manager.finish(runId)
      return currentRun(runId)
    }
    // Between turns of an exec agent (or after a restart) there is no process to close.
    const workspace = await requireCurrentWorkspace()
    return (await manager.endIdle(workspace.path, runId, 'finished')) ?? currentRun(runId)
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
