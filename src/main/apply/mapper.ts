import { buildChildEnv, findCli, loginShellPath } from '../cli/env'
import { requireSignedIn } from '../cli/install-claude'
import { defaultAgent, venvDir } from '../cli/start'
import { claudeVersion, supportsPermissionPrompts } from '../cli/version'
import type { MapperCli } from './map-questions'

/**
 * The small model that maps unknown application questions (#71): Claude
 * Haiku when `claude` is installed and signed in, else Antigravity's Gemini
 * Flash Low; Antigravity first when it is the default agent in Settings.
 * Null when neither is available (the questions then simply stay with the user).
 */
export async function availableMapper(workspace: string): Promise<MapperCli | null> {
  const [agent, loginPath] = await Promise.all([defaultAgent(), loginShellPath()])
  const env = buildChildEnv({ base: process.env, workspace, venvDir: venvDir(), texBin: null, loginPath })
  const claude = async (): Promise<MapperCli | null> => {
    const command = await findCli('claude')
    if (!command) return null
    try {
      const [version] = await Promise.all([claudeVersion(command, env), requireSignedIn(command, env)])
      return { agent: 'claude', command, env, permissionPrompts: supportsPermissionPrompts(version) }
    } catch {
      return null
    }
  }
  const agy = async (): Promise<MapperCli | null> => {
    const command = await findCli('agy')
    return command ? { agent: 'antigravity', command, env } : null
  }
  const order = agent === 'antigravity' ? [agy, claude] : [claude, agy]
  for (const pick of order) {
    const cli = await pick()
    if (cli) return cli
  }
  return null
}
