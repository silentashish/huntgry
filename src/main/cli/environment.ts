import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_IDS,
  AGENT_LABEL,
  CLAUDE_COMMANDS,
  DEFAULT_AGENT,
  type AgentId,
  type AgentStatus,
  type ClaudeAccount,
  type ClaudeAuth,
  type PreflightItem,
  type RunnerEnvironment
} from '@shared/runner-types'
import { adapterFor } from './agents'
import { skillStatus } from './agents/skills'
import { readSkillMd, skillSupportsSingleFlow, skillVersionWarning } from './skill-version'
import {
  buildChildEnv,
  claudeConfigDirChoice,
  claudeConfigDirFor,
  cliChoice,
  cliPin,
  composePath,
  defaultClaudeConfigDir,
  findClaude,
  findClaudeConfigDirs,
  findCli,
  findCliCandidates,
  findInDirs,
  findSkillDir,
  findTexBin,
  loginShellPath,
  parsePreflight,
  SKILL_PYTHON_MODULES,
  wellKnownBinDirs
} from './env'
import { SKILL_NAME } from '../workspace/constants'
import { claudeAuthStatus, claudeInstallKind } from './install-claude'
import { readSkillInstall } from './install-skill'
import { claudeVersion as readClaudeVersion, CLAUDE_VERSION_RECOMMENDED, versionAtLeast } from './version'

/**
 * Environment checks for the Settings page and the Tailor page's pre-run
 * check: the agent CLIs, the skill as each agent sees it, and the skill's own
 * `preflight.py` run with the PATH the real run gets.
 */

/** How to get a missing agent CLI. */
export const AGENT_INSTALL_HINT: Record<AgentId, string> = {
  claude: 'Use "Install Claude Code" in Settings, then sign in once in a terminal.',
  codex: 'Install it with "brew install --cask codex" or "npm install -g @openai/codex", then run "codex login" once.',
  antigravity: 'Install the Antigravity CLI (antigravity.google/docs/cli), then run "agy" once to sign in.'
}

/**
 * One agent's status from what was found. Pure. Claude's problems keep the
 * wording (and order) the Settings banner always had; the other agents need
 * the skill linked into their own skills folder.
 */
export function describeAgent(a: {
  id: AgentId
  cliPath: string | null
  version: string | null
  /** Every copy found (default: just `cliPath`). */
  cliCandidates?: string[]
  /** The copy chosen in Settings, if any. */
  cliChoice?: string | null
  cliPinned?: boolean
  skillPath: string | null
  skillTarget: string
  /** The Claude copy of the skill, which the other agents link to. */
  claudeSkill: string | null
  /** Claude only. */
  auth?: ClaudeAuth | null
}): AgentStatus {
  const label = AGENT_LABEL[a.id]
  const problems: string[] = []
  if (a.id === 'claude') {
    if (!a.cliPath) problems.push(`The claude CLI was not found. ${AGENT_INSTALL_HINT.claude}`)
    if (a.auth?.loggedIn === false)
      problems.push(
        `Claude Code is installed but not signed in. Run "${CLAUDE_COMMANDS.login}" in a terminal, then check again.`
      )
    if (!a.skillPath) problems.push('The resume-tailor skill is not installed. Use "Install resume-tailor skill" in Settings.')
  } else {
    if (!a.cliPath) problems.push(`The ${adapterFor(a.id).binary} CLI (${label}) was not found. ${AGENT_INSTALL_HINT[a.id]}`)
    if (!a.skillPath)
      problems.push(
        a.claudeSkill
          ? `${label} cannot see the resume-tailor skill yet. Use "Install skill" for ${label} in Settings → Agents.`
          : `Install the resume-tailor skill first (Settings), then "Install skill" for ${label}.`
      )
  }
  return {
    id: a.id,
    label,
    cliPath: a.cliPath,
    version: a.version,
    cliCandidates: a.cliCandidates ?? (a.cliPath ? [a.cliPath] : []),
    cliChoice: a.cliChoice ?? null,
    cliPinned: a.cliPinned ?? false,
    skillPath: a.skillPath,
    skillTarget: a.skillTarget,
    ready: problems.length === 0,
    problems
  }
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
  timeout = 20000
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, cwd, timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Just what a run needs to start: where `claude`, the skill and TeX are.
 * Cheap (file checks only, cached login PATH), unlike `checkEnvironment`,
 * which also runs `claude --version` and the skill's preflight.
 */
export async function discoverRuntime(): Promise<{
  claudePath: string | null
  skillDir: string | null
  texBin: string | null
}> {
  const [claudePath, skillDir, texBin] = await Promise.all([findClaude(), findSkillDir(), findTexBin()])
  return { claudePath, skillDir, texBin }
}

export async function checkEnvironment(opts: {
  venvDir: string
  workspace: string | null
  /** `<userData>/skill-install.json`, written when Huntgry installed the skill. */
  skillRecordPath?: string
  defaultAgent?: AgentId
  home?: string
}): Promise<RunnerEnvironment> {
  const home = opts.home ?? homedir()
  const defaultAgent = opts.defaultAgent ?? DEFAULT_AGENT
  const [claudePath, skillDir, texBin, loginPath] = await Promise.all([
    findClaude(),
    findSkillDir(),
    findTexBin(),
    loginShellPath()
  ])
  const venvReady = await exists(join(opts.venvDir, 'bin/python3'))
  const env = buildChildEnv({
    base: process.env,
    workspace: opts.workspace ?? '',
    venvDir: opts.venvDir,
    texBin,
    loginPath
  })

  let claudeVersion: string | null = null
  let claudeAuth: ClaudeAuth | null = null
  const configChoice = await claudeConfigDirChoice()
  const configDir = claudeConfigDirFor(process.env, configChoice, home) ?? defaultClaudeConfigDir(home)
  let claudeAccounts: ClaudeAccount[] = []
  if (claudePath) {
    const dirs = await findClaudeConfigDirs(home, [configChoice, process.env.CLAUDE_CONFIG_DIR])
    ;[claudeVersion, claudeAccounts] = await Promise.all([
      // Refresh the cache the runs use: this is what "Check again" is for (e.g. after an update).
      readClaudeVersion(claudePath, env, { refresh: true }),
      // Who is signed in under each folder, so the user can tell a work account from a personal one.
      Promise.all(
        dirs.map(async (dir): Promise<ClaudeAccount> => ({
          configDir: dir,
          isDefault: dir === defaultClaudeConfigDir(home),
          auth: await claudeAuthStatus(claudePath, { ...env, ...accountEnv(dir, home) })
        }))
      )
    ])
    const inUse = claudeAccounts.find((a) => a.configDir === configDir)
    claudeAuth = inUse ? inUse.auth : await claudeAuthStatus(claudePath, env)
  }
  const claudeVersionOk = versionAtLeast(claudeVersion, CLAUDE_VERSION_RECOMMENDED)
  const installKind = claudePath ? await claudeInstallKind(claudePath) : null
  const record = opts.skillRecordPath ? await readSkillInstall(opts.skillRecordPath) : null

  let preflight: PreflightItem[] = []
  let preflightOutput = ''
  if (skillDir) {
    const python = venvReady ? join(opts.venvDir, 'bin/python3') : 'python3'
    const r = await run(python, [join(skillDir, 'scripts/preflight.py')], env, skillDir)
    preflightOutput = r.out.trim()
    preflight = parsePreflight(r.out)
  }

  const agents = await Promise.all(
    AGENT_IDS.map(async (id): Promise<AgentStatus> => {
      const binary = adapterFor(id).binary
      const cli = { cliCandidates: await cliCandidates(binary, id === 'claude' ? claudePath : null), cliChoice: await cliChoice(binary), cliPinned: cliPin(binary) !== null }
      if (id === 'claude') {
        const skillTarget = join(adapterFor(id).skillRoots(home)[0], SKILL_NAME)
        return describeAgent({ id, cliPath: claudePath, version: claudeVersion, ...cli, skillPath: skillDir, skillTarget, claudeSkill: skillDir, auth: claudeAuth })
      }
      const [cliPath, skill] = await Promise.all([findCli(binary), skillStatus(id, home)])
      const version = cliPath ? await readClaudeVersion(cliPath, env, { refresh: true }) : null
      return describeAgent({ id, cliPath, version, ...cli, skillPath: skill.path, skillTarget: skill.target, claudeSkill: skillDir })
    })
  )

  const shared: string[] = []
  if (
    skillDir &&
    !venvReady &&
    preflight.some(
      (p) => p.status === 'missing' && SKILL_PYTHON_MODULES.some((m) => p.name.includes(m.replace('python-', '')))
    )
  ) {
    shared.push('Python modules are missing: use "Install Python dependencies".')
  }
  if (!texBin)
    shared.push('No LaTeX (pdflatex) found. Install TinyTeX (no admin needed) or BasicTeX, then check again.')
  for (const p of preflight) {
    if (p.status === 'missing' && !shared.some((q) => q.includes(p.name)))
      shared.push(`Missing: ${p.name}${p.detail ? ` (${p.detail})` : ''}`)
  }
  // The banner and `ready` are about the agent new runs use.
  const problems = [...agents.find((a) => a.id === defaultAgent)!.problems, ...shared]

  const warnings: string[] = []
  if (claudePath && !claudeVersionOk)
    warnings.push(
      claudeVersion
        ? `Claude Code ${claudeVersion} is older than ${CLAUDE_VERSION_RECOMMENDED}. Runs work, but update it (Update Claude Code).`
        : `The Claude Code version could not be read ("claude --version" failed or hung). Runs still start; updating Claude Code usually fixes this.`
    )

  const skillInstall = record && skillDir && record.path === skillDir ? { tag: record.tag, installedAt: record.installedAt } : null
  const skillSingleFlow = skillDir ? skillSupportsSingleFlow(await readSkillMd(skillDir), skillInstall?.tag ?? null) : null
  if (skillSingleFlow === false) warnings.push(skillVersionWarning(skillInstall?.tag ?? null))

  return {
    claudePath,
    claudeVersion,
    claudeVersionOk,
    recommendedClaudeVersion: CLAUDE_VERSION_RECOMMENDED,
    claudeInstallKind: installKind,
    claudeAuth,
    claudeConfigDir: configDir,
    claudeConfigChoice: configChoice,
    claudeAccounts,
    skillInstall,
    skillSingleFlow,
    skillDir,
    venvDir: opts.venvDir,
    venvReady,
    texBin,
    preflight,
    preflightOutput,
    ready: problems.length === 0 && preflight.length > 0,
    problems,
    warnings,
    defaultAgent,
    agents,
    sharedProblems: shared
  }
}

/** `CLAUDE_CONFIG_DIR` for the account in `dir`: unset for the default folder (see `defaultClaudeConfigDir`). */
function accountEnv(dir: string, home: string): NodeJS.ProcessEnv {
  return { CLAUDE_CONFIG_DIR: dir === defaultClaudeConfigDir(home) ? undefined : dir }
}

/** The copies the search finds, plus a chosen one outside the searched folders (picked in a dialog). */
async function cliCandidates(binary: string, known: string | null): Promise<string[]> {
  const found = await findCliCandidates(binary)
  const chosen = known ?? (await findCli(binary))
  return chosen && !found.includes(chosen) ? [chosen, ...found] : found
}

/** A system Python 3 to create the venv with. */
async function findSystemPython(): Promise<string | null> {
  const dirs = composePath(wellKnownBinDirs().join(':'), await loginShellPath(), '/usr/bin').split(':')
  return findInDirs('python3', dirs)
}

/** (Re)creates the venv and installs the skill's modules, streaming output lines to `log`. */
export async function installPythonDeps(
  venvDir: string,
  log: (line: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const python = await findSystemPython()
  if (!python) return { ok: false, error: 'python3 was not found. Install Python 3 (e.g. `brew install python`).' }

  const step = (cmd: string, args: string[]) =>
    new Promise<number>((resolve) => {
      log(`$ ${[cmd, ...args].join(' ')}`)
      const child = spawn(cmd, args, { env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' } })
      const onData = (chunk: Buffer) =>
        chunk
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim())
          .forEach(log)
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (err) => {
        log(err.message)
        resolve(1)
      })
      child.on('close', (code) => resolve(code ?? 1))
    })

  if ((await step(python, ['-m', 'venv', venvDir])) !== 0)
    return { ok: false, error: 'Creating the virtual environment failed.' }
  const pip = join(venvDir, 'bin/python3')
  if ((await step(pip, ['-m', 'pip', 'install', '--upgrade', ...SKILL_PYTHON_MODULES])) !== 0) {
    return { ok: false, error: 'pip install failed; see the log.' }
  }
  log('Done.')
  return { ok: true }
}
