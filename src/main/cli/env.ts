import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, opendir, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { PreflightItem } from '@shared/runner-types'
import { SKILL_NAME } from '../workspace/constants'

/**
 * Where the `claude` binary, the resume-tailor skill and the skill's
 * dependencies live, and the environment its child process gets. A GUI app on
 * macOS starts with a minimal PATH (`/usr/bin:/bin:…`), so nothing here may
 * rely on the app's own PATH.
 */

/** Python modules the skill imports (see its `scripts/preflight.py`). */
export const SKILL_PYTHON_MODULES = ['pydantic', 'jinja2', 'pymupdf', 'python-docx'] as const

/** Folders commonly holding user-installed CLIs on macOS/Linux, checked before the login-shell PATH. */
export function wellKnownBinDirs(home = homedir()): string[] {
  return [
    join(home, '.local/bin'),
    join(home, '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global/bin'),
    join(home, '.volta/bin'),
    join(home, '.bun/bin')
  ]
}

/**
 * `HUNTGRY_E2E=1` puts CLI discovery in an isolated mode for the end-to-end
 * tests (see docs/testing/e2e.md): no login-shell PATH, no machine-wide
 * folders, only the folders below `HOME` and the app's own PATH, both of which
 * the test harness controls. Off in packaged builds, whatever the environment
 * says; main sets the build kind once at startup (`setPackagedBuild`).
 */
export const E2E_ENV = 'HUNTGRY_E2E'

let packagedBuild = true

/** Called once from main with `app.isPackaged`; until then the app counts as packaged, so the escape stays off. */
export function setPackagedBuild(isPackaged: boolean): void {
  packagedBuild = isPackaged
}

/** What main reported through `setPackagedBuild` (packaged until told otherwise). */
export function isPackagedBuild(): boolean {
  return packagedBuild
}

export function isolatedDiscovery(env: NodeJS.ProcessEnv = process.env, isPackaged = packagedBuild): boolean {
  return !isPackaged && env[E2E_ENV] === '1'
}

/**
 * Directories `findCli` searches, in order: the well-known folders, the
 * login-shell PATH, the app's PATH. In isolated mode (`HUNTGRY_E2E=1`), only
 * the well-known folders below `home` and the app's PATH.
 */
export async function cliSearchDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string[]> {
  return composePath(discoveryBinDirs(env, home).join(delimiter), await loginShellPath(env), env.PATH).split(delimiter)
}

/** The well-known folders discovery may use: all of them, or only those below `home` in isolated mode. */
export function discoveryBinDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const wellKnown = wellKnownBinDirs(home)
  return isolatedDiscovery(env) ? wellKnown.filter((dir) => dir.startsWith(home + '/')) : wellKnown
}

/** TeX distributions, most specific first. TinyTeX installs per user and needs no sudo. */
export function texBinCandidates(home = homedir()): string[] {
  return [
    join(home, 'Library/TinyTeX/bin/universal-darwin'),
    join(home, 'Library/TinyTeX/bin/x86_64-darwin'),
    join(home, '.TinyTeX/bin/x86_64-linux'),
    join(home, '.TinyTeX/bin/aarch64-linux'),
    '/Library/TeX/texbin',
    '/usr/local/texlive/bin',
    '/usr/bin'
  ]
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First directory in `dirs` that holds an executable `name`. */
export async function findInDirs(name: string, dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    if (dir && (await isExecutable(join(dir, name)))) return join(dir, name)
  }
  return null
}

let loginPathCache: Promise<string> | null = null

/**
 * The PATH an interactive login shell would have, so tools installed through
 * shell profiles (nvm, asdf, brew shellenv) are found. Cached; empty on failure.
 */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  // Isolated mode: the user's shell profiles must not leak their PATH into the app or its children.
  if (isolatedDiscovery(env)) return Promise.resolve('')
  loginPathCache ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      const m = !err && /__PATH__(.*)$/m.exec(stdout)
      resolve(m ? m[1].trim() : '')
    })
  })
  return loginPathCache
}

/** Joins PATH segments, dropping blanks and duplicates while keeping the first occurrence's position. */
export function composePath(...segments: (string | null | undefined)[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const seg of segments) {
    for (const dir of (seg ?? '').split(delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        out.push(dir)
      }
    }
  }
  return out.join(delimiter)
}

/**
 * Resolves the `claude` CLI: well-known folders, then the login-shell PATH, then
 * the app's PATH. `HUNTGRY_CLAUDE_PATH` in the app's own environment (never from
 * the renderer) pins a binary, e.g. to test an older Claude Code.
 */
export async function findClaude(): Promise<string | null> {
  return findCli('claude')
}

/**
 * Resolves an agent CLI (`claude`, `codex`, `agy`) the same way: well-known
 * folders, the login-shell PATH, the app's PATH. `HUNTGRY_<NAME>_PATH` in the
 * app's own environment pins a binary (e.g. `HUNTGRY_CLAUDE_PATH`).
 */
export async function findCli(name: string): Promise<string | null> {
  const pinned = cliPin(name)
  if (pinned) return (await isExecutable(pinned)) ? pinned : null
  const chosen = cliChoices[name]
  if (chosen && (await isExecutable(chosen))) return chosen
  return findInDirs(name, await cliSearchDirs())
}

/**
 * The CLI copy the user chose in Settings → Agents (#79), by executable name
 * (`claude`, `codex`, `agy`). `findCli` uses it before searching; a chosen
 * copy that is gone or no longer executable falls back to the search.
 * Main loads it from the settings file; the renderer never sets it directly.
 */
let cliChoices: Record<string, string> = {}

export function setCliChoices(choices: Record<string, string> | undefined): void {
  cliChoices = { ...(choices ?? {}) }
}

/** The chosen copy of `name`, if any (whether or not it still exists). */
export function cliChoice(name: string): string | null {
  return cliChoices[name] ?? null
}

/** Every executable `name` in `dirs`, in search order, without copies reached twice through the same real file. */
export async function findAllInDirs(name: string, dirs: readonly string[]): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  for (const dir of new Set(dirs)) {
    if (!dir) continue
    const path = join(dir, name)
    if (!(await isExecutable(path))) continue
    const real = await realpath(path).catch(() => path)
    if (seen.has(real)) continue
    seen.add(real)
    found.push(path)
  }
  return found
}

/** `HUNTGRY_<NAME>_PATH` from the app's own environment: it wins over any choice and any search. */
export function cliPin(name: string): string | null {
  return process.env[`HUNTGRY_${name.toUpperCase()}_PATH`] || null
}

/**
 * Every copy of an agent CLI the search finds (the first one is what `findCli` picks without a choice).
 * Under a `HUNTGRY_<NAME>_PATH` pin, only the pinned one: no other copy could run.
 */
export async function findCliCandidates(name: string): Promise<string[]> {
  const pinned = cliPin(name)
  if (pinned) return (await isExecutable(pinned)) ? [pinned] : []
  return findAllInDirs(name, await cliSearchDirs())
}

export async function findTexBin(): Promise<string | null> {
  for (const dir of texBinCandidates()) {
    if (await isExecutable(join(dir, 'pdflatex'))) return dir
  }
  return null
}

/** Folders searched for an installed skill (personal skills, plugin and synced skill caches). */
export function skillSearchRoots(home = homedir()): string[] {
  return [join(home, '.claude/skills'), join(home, '.claude/plugins')]
}

const MAX_SKILL_SEARCH_DEPTH = 5
const MAX_SKILL_SEARCH_ENTRIES = 4000

/**
 * Finds `<dir>/resume-tailor/SKILL.md` below the search roots (bounded, no
 * symlink loops). Several copies can exist (personal + synced); the shallowest
 * wins, which is the personal `~/.claude/skills/resume-tailor` when present.
 */
export async function findSkillDir(roots = skillSearchRoots()): Promise<string | null> {
  let visited = 0
  let queue = roots.map((dir) => ({ dir, depth: 0 }))
  while (queue.length > 0) {
    const next: typeof queue = []
    for (const { dir, depth } of queue) {
      let handle
      try {
        handle = await opendir(dir)
      } catch {
        continue
      }
      for await (const e of handle) {
        if (++visited > MAX_SKILL_SEARCH_ENTRIES) return null
        if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
        const path = join(dir, e.name)
        if (e.name === SKILL_NAME) {
          try {
            if ((await readdir(path)).includes('SKILL.md')) return path
          } catch {
            // unreadable: keep looking
          }
        }
        if (depth + 1 < MAX_SKILL_SEARCH_DEPTH) next.push({ dir: path, depth: depth + 1 })
      }
    }
    queue = next
  }
  return null
}

/**
 * Environment of the `claude` child: the venv's `python3` first, then TeX and
 * the usual CLI folders, `CV_HOME` pointing at the workspace. Variables that
 * would make the child think it runs nested inside another Claude Code session
 * are removed. In isolated mode (`HUNTGRY_E2E=1` in `base`) the machine-wide
 * folders and the login-shell PATH stay out, like in `cliSearchDirs`.
 */
export function buildChildEnv(opts: {
  base: NodeJS.ProcessEnv
  workspace: string
  venvDir: string
  texBin: string | null
  loginPath: string
  home?: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(opts.base)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'ELECTRON_RUN_AS_NODE') continue
    env[k] = v
  }
  const isolated = isolatedDiscovery(opts.base)
  env.PATH = composePath(
    join(opts.venvDir, 'bin'),
    opts.texBin,
    discoveryBinDirs(opts.base, opts.home).join(delimiter),
    isolated ? null : opts.loginPath,
    opts.base.PATH,
    '/usr/bin:/bin:/usr/sbin:/sbin'
  )
  env.CV_HOME = opts.workspace
  env.VIRTUAL_ENV = opts.venvDir
  return env
}

/**
 * Parses `scripts/preflight.py` output: `ok    <name>`, `MISSING <name> - <why>`,
 * `--    <name> <note>` (optional). Other lines are ignored.
 */
export function parsePreflight(output: string): PreflightItem[] {
  const items: PreflightItem[] = []
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    let m = /^ok\s+(.+)$/.exec(line)
    if (m) {
      items.push({ name: m[1].replace(/\s*\(optional\)$/, ''), status: 'ok', detail: '' })
      continue
    }
    m = /^MISSING\s+(.+?)(?:\s+-\s+(.*))?$/.exec(line)
    if (m) {
      items.push({ name: m[1], status: 'missing', detail: m[2] ?? '' })
      continue
    }
    m = /^--\s+(\S+)\s*(.*)$/.exec(line)
    if (m) items.push({ name: m[1], status: 'optional', detail: m[2].replace(/^-\s*/, '') })
  }
  return items
}
