import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_LABEL, type AgentId, type RunSummary } from '@shared/runner-types'
import { requireCurrentWorkspace, settingsFile } from '../current-workspace'
import { emit } from '../events'
import { loadSettings, saveSettings } from '../workspace'
import { adapterFor, agentOr } from './agents'
import { agyModel } from './agents/antigravity'
import { codexModel } from './agents/codex'
import { skillStatus } from './agents/skills'
import { buildSystemPrompt, requireStartParams, resolveRunPaths, texRootOf, type UnattendedPromptOptions } from './command'
import {
  buildChildEnv,
  claudeConfigDirChoice,
  claudeConfigDirFor,
  cliChoice,
  cliPin,
  defaultClaudeConfigDir,
  findClaudeConfigDirs,
  findCli,
  findCliCandidates,
  findTexBin,
  isExecutable,
  loadingCliChoices,
  loginShellPath,
  setClaudeConfigChoice,
  setCliChoices
} from './env'
import { discoverRuntime } from './environment'
import { requireSignedIn } from './install-claude'
import { fetchPostingText } from './posting'
import { pinnedFetch } from './public-url'
import { RunManager, type RunContext } from './runner'
import { readRun } from './runs'
import { approvalsForPrompt, loadApprovals } from '../review/approvals'
import { reopenForContinuation } from '../review/authority'
import { currentPrices, withPrices } from './usage'
import { claudeVersion, supportsPermissionPrompts } from './version'

/**
 * The app's one `RunManager` and how a tailoring run is started, shared by the
 * Tailor page's Start button and the bulk queue.
 */

/** The venv the skill's `python3` comes from. Shared by every workspace. */
export const venvDir = (): string => join(app.getPath('userData'), 'skill-venv')

const runListeners = new Set<(run: RunSummary) => void>()

export const manager = new RunManager({
  onEvent: (runId, seq, event) => emit('runner:event', { runId, seq, event }),
  onRun: (run) => {
    emit('runner:run', withPrices(run))
    for (const listener of runListeners) listener(run)
  },
  // Every continuation of an unattended result (Tailor reply, Review re-run, nudge) revokes its approval first.
  beforeReply: async (run, workspace) => {
    if ((run.unattended || run.params.unattended) && run.outputFolder)
      await reopenForContinuation(workspace, run.outputFolder, run.id, new Date())
  },
  prices: currentPrices
})

/** Called with every run summary change (the bulk queue follows its runs this way). */
export function onRunChange(listener: (run: RunSummary) => void): () => void {
  runListeners.add(listener)
  return () => runListeners.delete(listener)
}

/** Stops every run and resolves once the processes are gone and their state is on disk. */
export async function stopAllRuns(): Promise<void> {
  manager.stopAll()
  await manager.whenIdle()
}

/** The agent new runs use (Settings), Claude when unset or unknown. */
export async function defaultAgent(): Promise<AgentId> {
  return agentOr((await loadSettings(settingsFile())).defaultAgent)
}

export async function setDefaultAgent(agent: AgentId): Promise<void> {
  await saveSettings(settingsFile(), { defaultAgent: agent })
}

/** Applies the CLI copies chosen in Settings (#79) to every later `findCli`. Called once at startup. */
export function loadCliChoices(): Promise<void> {
  const settings = loadSettings(settingsFile())
  return loadingCliChoices(
    settings.then((s) => s.cliPaths),
    settings.then((s) => s.claudeConfigDir)
  )
}

/** CLI-choice updates, one after another, so two quick changes never save over each other. */
let cliPathUpdates: Promise<unknown> = Promise.resolve()

/**
 * Runs `agent` with the CLI at `path` from now on, or, with `null`, with the first copy found (#79).
 * `fromDialog`: the user picked `path` in a file dialog; otherwise it must be a copy the search finds,
 * so the renderer cannot name an arbitrary file to execute.
 */
export function setCliPath(agent: AgentId, path: string | null, fromDialog = false): Promise<void> {
  const update = cliPathUpdates.then(() => applyCliPath(agent, path, fromDialog))
  cliPathUpdates = update.catch(() => {})
  return update
}

async function applyCliPath(agent: AgentId, path: string | null, fromDialog: boolean): Promise<void> {
  const binary = adapterFor(agent).binary
  if (cliPin(binary)) throw new Error(`HUNTGRY_${binary.toUpperCase()}_PATH pins the ${AGENT_LABEL[agent]} CLI; unset it to choose another copy.`)
  // Also waits for the startup load, so it cannot replace this update with the older choices.
  const current = await cliChoice(binary)
  if (path !== null) {
    if (!fromDialog && path !== current && !(await findCliCandidates(binary)).includes(path))
      throw new Error(`${path} is not a ${AGENT_LABEL[agent]} CLI Huntgry found.`)
    if (!(await isExecutable(path))) throw new Error(`${path} is not an executable file.`)
  }
  const { cliPaths = {} } = await loadSettings(settingsFile())
  const next = { ...cliPaths }
  if (path === null) delete next[binary]
  else next[binary] = path
  await saveSettings(settingsFile(), { cliPaths: next })
  setCliChoices(next)
}

/**
 * Runs Claude with the account in config folder `dir` from now on, or, with `null`, the default one.
 * `fromDialog`: the user picked `dir` in a folder dialog; otherwise it must be a folder the search finds,
 * so the renderer cannot point Claude at an arbitrary folder.
 */
export function setClaudeAccount(dir: string | null, fromDialog = false): Promise<void> {
  const update = cliPathUpdates.then(() => applyClaudeAccount(dir, fromDialog))
  cliPathUpdates = update.catch(() => {})
  return update
}

async function applyClaudeAccount(dir: string | null, fromDialog: boolean): Promise<void> {
  const current = await claudeConfigDirChoice()
  if (dir !== null && !fromDialog && dir !== current && !(await findClaudeConfigDirs(homedir(), [process.env.CLAUDE_CONFIG_DIR])).includes(dir))
    throw new Error(`${dir} is not a Claude config folder Huntgry found.`)
  // `null` is the default folder. It is the same as no choice (CLAUDE_CONFIG_DIR unset), unless the app's own
  // environment names another folder: then it is saved, so it wins over the inherited one.
  const wanted = dir ?? defaultClaudeConfigDir()
  const next = wanted === defaultClaudeConfigDir() && !process.env.CLAUDE_CONFIG_DIR ? null : wanted
  await saveSettings(settingsFile(), { claudeConfigDir: next ?? undefined })
  setClaudeConfigChoice(next)
}

/** The context to continue run `runId` of the open workspace with: always the run's own agent and prompt variant. */
export async function contextForRun(runId: string, expectedWorkspace?: string): Promise<RunContext> {
  const workspace = await requireCurrentWorkspace()
  const run = await readRun(expectedWorkspace ?? workspace.path, runId)
  return context(expectedWorkspace, run.agent, { unattended: run.unattended === true || run.params.unattended === true })
}

/** The standing approvals an unattended run gets in its prompt (newest first, capped). */
async function unattendedPrompt(workspace: string): Promise<UnattendedPromptOptions> {
  return { approvals: approvalsForPrompt(await loadApprovals(workspace)).sent }
}

/**
 * Everything a run of `agent` needs (default: the Settings default).
 * `expectedWorkspace`: refuse to build a context for any other workspace (the queue's jobs belong to one).
 * `opts.unattended`: the unattended prompt variant with the workspace's standing approvals (#31).
 */
export async function context(
  expectedWorkspace?: string,
  agent?: AgentId,
  opts: { unattended?: boolean } = {}
): Promise<RunContext> {
  const workspace = await requireCurrentWorkspace()
  if (expectedWorkspace !== undefined && workspace.path !== expectedWorkspace) {
    throw new Error('Another workspace was opened while this job was starting.')
  }
  const unattended = opts.unattended ? await unattendedPrompt(workspace.path) : undefined
  const id = agent ?? (await defaultAgent())
  if (id !== 'claude') return otherAgentContext(id, workspace, unattended)
  // File checks only: the full preflight is for Settings and the Tailor form's warning.
  const env = await discoverRuntime()
  if (!env.claudePath) throw new Error('The claude CLI was not found. See Settings.')
  if (!env.skillDir) throw new Error('The resume-tailor skill was not found. See Settings.')
  const childEnv = buildChildEnv({
    base: process.env,
    workspace: workspace.path,
    venvDir: venvDir(),
    texBin: env.texBin,
    loginPath: await loginShellPath()
  })
  const [version] = await Promise.all([
    // Once per binary (cached by real path); an unknown version just leaves out the newer flags.
    claudeVersion(env.claudePath, childEnv),
    // A signed-out CLI would only produce a failed run; say what to do instead (start and resume).
    requireSignedIn(env.claudePath, childEnv)
  ])
  // The skill at its real path: the chosen account's skills folder may be a link (#144).
  const { skillDir, sandbox } = await resolveRunPaths({
    workspace: workspace.path,
    skillDir: env.skillDir,
    venvDir: venvDir(),
    texRoot: texRootOf(env.texBin)
  })
  return {
    agent: 'claude',
    workspace: workspace.path,
    skillDir,
    sandbox,
    command: env.claudePath,
    env: childEnv,
    claudeVersion: version,
    permissionPrompts: supportsPermissionPrompts(version),
    model: await preferredModel(),
    systemPrompt: buildSystemPrompt({
      workspace: workspace.path,
      masterProfile: workspace.masterProfile,
      skillDir,
      unattended
    })
  }
}

/** Codex and Antigravity: their CLI, the skill as they see it (linked into their skills folder), no Claude checks. */
async function otherAgentContext(
  agent: Exclude<AgentId, 'claude'>,
  workspace: { path: string; masterProfile: string },
  unattended?: UnattendedPromptOptions
): Promise<RunContext> {
  const adapter = adapterFor(agent)
  const label = AGENT_LABEL[agent]
  const [cliPath, skill, texBin, loginPath] = await Promise.all([
    findCli(adapter.binary),
    skillStatus(agent, homedir()),
    findTexBin(),
    loginShellPath()
  ])
  if (!cliPath) throw new Error(`The ${adapter.binary} CLI (${label}) was not found. See Settings → Agents.`)
  if (!skill.path)
    throw new Error(`${label} cannot see the resume-tailor skill. Use "Install skill" for ${label} in Settings → Agents.`)
  // Their skill is a link to the Claude copy (`installAgentSkill`): run it at its real path (#144).
  const { skillDir, sandbox } = await resolveRunPaths({
    workspace: workspace.path,
    skillDir: skill.path,
    venvDir: venvDir(),
    texRoot: texRootOf(texBin)
  })
  return {
    agent,
    workspace: workspace.path,
    skillDir,
    sandbox,
    command: cliPath,
    env: buildChildEnv({ base: process.env, workspace: workspace.path, venvDir: venvDir(), texBin, loginPath }),
    ...(agent === 'codex'
      ? { model: await codexModel(homedir()) }
      : // agy gets no --model: it runs the model of its own settings, read only to price the run (#44).
        { expectedModel: (await agyModel(homedir())) ?? null }),
    systemPrompt: buildSystemPrompt({ workspace: workspace.path, masterProfile: workspace.masterProfile, skillDir, unattended })
  }
}

/**
 * The model the user chose for Claude Code (`model` in the chosen account's `settings.json`, `~/.claude` by default).
 * Runs load no settings files, so it is passed explicitly; `undefined` = Claude's default.
 */
async function preferredModel(): Promise<string | undefined> {
  const configDir = claudeConfigDirFor(process.env, await claudeConfigDirChoice()) ?? defaultClaudeConfigDir()
  try {
    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8')) as {
      model?: unknown
    }
    return typeof settings.model === 'string' && /^[\w.[\]:/@-]{1,300}$/.test(settings.model)
      ? settings.model
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Validates the parameters, reads a posting given only by URL (agents get no
 * network access, so it is fetched here) and starts the run with the chosen
 * agent (the default agent when none is given).
 */
export async function startTailorRun(input: unknown, expectedWorkspace?: string): Promise<RunSummary> {
  const params = requireStartParams(input)
  params.agent ??= await defaultAgent()
  // Checks the agent's CLI and skill before fetching anything.
  const ctx = await context(expectedWorkspace, params.agent, { unattended: params.unattended === true })
  if (!params.jobDescription?.trim() && params.jobUrl) {
    params.jobDescription = await fetchPostingText(params.jobUrl, pinnedFetch)
  }
  return manager.start(params, ctx)
}
