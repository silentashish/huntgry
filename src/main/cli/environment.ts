import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { PreflightItem, RunnerEnvironment } from '@shared/runner-types'
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

export async function checkEnvironment(opts: {
  venvDir: string
  workspace: string | null
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
  if (claudePath) {
    const v = await run(claudePath, ['--version'], env)
    claudeVersion = v.code === 0 ? v.out.trim().split('\n')[0] : null
  }

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
    problems.push(
      'The claude CLI was not found. Install Claude Code (https://claude.com/claude-code) and sign in once in a terminal.'
    )
  if (!skillDir)
    problems.push(
      'The resume-tailor skill is not installed under ~/.claude/skills (github.com/silentashish/claude-resume-generator-skill).'
    )
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

  return {
    claudePath,
    claudeVersion,
    skillDir,
    venvDir: opts.venvDir,
    venvReady,
    texBin,
    preflight,
    preflightOutput,
    ready: problems.length === 0 && preflight.length > 0,
    problems
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
