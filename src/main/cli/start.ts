import { app } from 'electron'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RunSummary } from '@shared/runner-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { buildSystemPrompt, requireStartParams, texRootOf } from './command'
import { buildChildEnv, loginShellPath } from './env'
import { discoverRuntime } from './environment'
import { requireSignedIn } from './install-claude'
import { fetchPostingText } from './posting'
import { pinnedFetch } from './public-url'
import { RunManager, type RunContext } from './runner'
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
    emit('runner:run', run)
    for (const listener of runListeners) listener(run)
  }
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

export async function context(): Promise<RunContext> {
  const workspace = await requireCurrentWorkspace()
  // File checks only: the full preflight is for Settings and the Tailor form's warning.
  const env = await discoverRuntime()
  if (!env.claudePath) throw new Error('The claude CLI was not found. See Settings.')
  if (!env.skillDir) throw new Error('The resume-tailor skill was not found. See Settings.')
  // Sandbox rules apply to real paths; allow the given spelling and its target (the venv may be a symlink).
  const real = async (p: string) => [p, await realpath(p).catch(() => p)]
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
  const texRoot = texRootOf(env.texBin)
  const allow = [
    ...new Set(
      (await Promise.all([workspace.path, env.skillDir, venvDir(), ...(texRoot ? [texRoot] : [])].map(real))).flat()
    )
  ]
  return {
    workspace: workspace.path,
    skillDir: env.skillDir,
    sandbox: { workspace: workspace.path, skillDir: env.skillDir, venvDir: venvDir(), texRoot, extraRead: allow },
    command: env.claudePath,
    env: childEnv,
    claudeVersion: version,
    permissionPrompts: supportsPermissionPrompts(version),
    model: await preferredModel(),
    systemPrompt: buildSystemPrompt({
      workspace: workspace.path,
      masterProfile: workspace.masterProfile,
      skillDir: env.skillDir
    })
  }
}

/**
 * The model the user chose for Claude Code (`model` in ~/.claude/settings.json).
 * Runs load no settings files, so it is passed explicitly; `undefined` = Claude's default.
 */
async function preferredModel(): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {
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
 * Validates the parameters, reads a posting given only by URL (Claude gets no
 * network access, so it is fetched here) and starts the run.
 */
export async function startTailorRun(input: unknown): Promise<RunSummary> {
  const params = requireStartParams(input)
  if (!params.jobDescription?.trim() && params.jobUrl) {
    params.jobDescription = await fetchPostingText(params.jobUrl, pinnedFetch)
  }
  return manager.start(params, await context())
}
