import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_COMMANDS, type ClaudeAuth, type PreflightItem, type RunnerEnvironment } from '@shared/runner-types'
import {
  buildChildEnv,
  composePath,
  findClaude,
  findInDirs,
  findSkillDir,
  findTexBin,
  loginShellPath,
  parsePreflight,
  SKILL_PYTHON_MODULES,
  wellKnownBinDirs
} from './env'
import { claudeInstallKind, parseAuthStatus } from './install-claude'
import { readSkillInstall } from './install-skill'
import { claudeVersion as readClaudeVersion, CLAUDE_VERSION_RECOMMENDED, versionAtLeast } from './version'

/**
 * Environment checks for the Settings page and the Tailor page's pre-run
 * check: `claude`, the skill, and the skill's own `preflight.py` run with the
 * PATH the real run gets.
 */

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
}): Promise<RunnerEnvironment> {
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
  if (claudePath) {
    const [version, auth] = await Promise.all([
      // Refresh the cache the runs use: this is what "Check again" is for (e.g. after an update).
      readClaudeVersion(claudePath, env, { refresh: true }),
      run(claudePath, ['auth', 'status'], env)
    ])
    claudeVersion = version
    claudeAuth = parseAuthStatus(auth.code, auth.out)
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

  const problems: string[] = []
  if (!claudePath)
    problems.push('The claude CLI was not found. Use "Install Claude Code" in Settings, then sign in once in a terminal.')
  if (claudeAuth?.loggedIn === false)
    problems.push(
      `Claude Code is installed but not signed in. Run \`${CLAUDE_COMMANDS.login}\` in a terminal, then check again.`
    )
  if (!skillDir) problems.push('The resume-tailor skill is not installed. Use "Install resume-tailor skill" in Settings.')
  if (
    skillDir &&
    !venvReady &&
    preflight.some(
      (p) => p.status === 'missing' && SKILL_PYTHON_MODULES.some((m) => p.name.includes(m.replace('python-', '')))
    )
  ) {
    problems.push('Python modules are missing: use "Install Python dependencies".')
  }
  if (!texBin)
    problems.push('No LaTeX (pdflatex) found. Install TinyTeX (no admin needed) or BasicTeX, then check again.')
  for (const p of preflight) {
    if (p.status === 'missing' && !problems.some((q) => q.includes(p.name)))
      problems.push(`Missing: ${p.name}${p.detail ? ` (${p.detail})` : ''}`)
  }

  const warnings: string[] = []
  if (claudePath && !claudeVersionOk)
    warnings.push(
      claudeVersion
        ? `Claude Code ${claudeVersion} is older than ${CLAUDE_VERSION_RECOMMENDED}. Runs work, but update it (Update Claude Code).`
        : `The Claude Code version could not be read (\`claude --version\` failed or hung). Runs still start; updating Claude Code usually fixes this.`
    )

  return {
    claudePath,
    claudeVersion,
    claudeVersionOk,
    recommendedClaudeVersion: CLAUDE_VERSION_RECOMMENDED,
    claudeInstallKind: installKind,
    claudeAuth,
    skillInstall: record && skillDir && record.path === skillDir ? { tag: record.tag, installedAt: record.installedAt } : null,
    skillDir,
    venvDir: opts.venvDir,
    venvReady,
    texBin,
    preflight,
    preflightOutput,
    ready: problems.length === 0 && preflight.length > 0,
    problems,
    warnings
  }
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
