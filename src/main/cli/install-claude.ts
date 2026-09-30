import { spawn } from 'node:child_process'
import { realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_COMMANDS, type ClaudeAuth, type ClaudeInstallKind, type InstallResult } from '@shared/runner-types'

/**
 * Installs and updates Claude Code with its official tools: the native
 * installer (`claude.ai/install.sh`, which verifies the binary's checksum and
 * puts the launcher in `~/.local/bin`, a folder `findClaude` checks first) and
 * `claude update`. Homebrew installs are never upgraded behind the user's back;
 * they get the command to run.
 */

export const INSTALL_SCRIPT_URL = 'https://claude.ai/install.sh'

const MAX_SCRIPT_BYTES = 1024 * 1024
const INSTALL_TIMEOUT_MS = 10 * 60_000

/** How a `claude` binary was installed, from its real path. */
export function installKindOf(realPath: string): ClaudeInstallKind {
  if (/\/\.local\/share\/claude\/versions\//.test(realPath) || /\/\.claude\/local\//.test(realPath)) return 'native'
  if (/\/Caskroom\//.test(realPath) || /\/Cellar\//.test(realPath)) return 'homebrew'
  if (/\/node_modules\//.test(realPath)) return 'npm'
  return 'other'
}

export async function claudeInstallKind(claudePath: string): Promise<ClaudeInstallKind> {
  return installKindOf(await realpath(claudePath).catch(() => claudePath))
}

/**
 * `claude auth status` output (JSON, exit 0 when signed in, 1 when not).
 * `null` when the output says nothing either way.
 */
export function parseAuthStatus(code: number, out: string): ClaudeAuth | null {
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>
      if (typeof j.loggedIn === 'boolean') {
        const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
        return {
          loggedIn: j.loggedIn,
          email: str(j.email),
          authMethod: str(j.authMethod),
          subscriptionType: str(j.subscriptionType)
        }
      }
    } catch {
      // fall through
    }
  }
  return code === 1 && /not (logged|signed) in/i.test(out) ? { loggedIn: false } : null
}

let busy = false

/** Runs one installer at a time (Claude Code, the skill); errors become `{ ok: false }`. */
export async function exclusive<T extends InstallResult>(
  log: (line: string) => void,
  job: () => Promise<T>
): Promise<T | InstallResult> {
  if (busy) return { ok: false, error: 'An install is already running.' }
  busy = true
  try {
    return await job()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(message)
    return { ok: false, error: message }
  } finally {
    busy = false
  }
}

/** Child env without the variables that make `claude` think it runs nested in another session. */
function installerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'ELECTRON_RUN_AS_NODE') continue
    env[k] = v
  }
  env.PATH = [base.PATH, '/usr/bin:/bin:/usr/sbin:/sbin'].filter(Boolean).join(':')
  return env
}

function stream(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  timeout = INSTALL_TIMEOUT_MS
): Promise<number> {
  return new Promise((resolve) => {
    log(`$ ${[cmd, ...args].join(' ')}`)
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      log('Timed out.')
      child.kill('SIGTERM')
    }, timeout)
    const onData = (chunk: Buffer) =>
      chunk
        .toString('utf8')
        // Installer progress bars redraw with \r and colour codes.
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .split(/[\r\n]+/)
        .filter((l) => l.trim())
        .forEach(log)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => {
      log(err.message)
      clearTimeout(timer)
      resolve(1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

/** Downloads the official installer and runs it with `bash install.sh latest`. */
export function installClaude(
  log: (line: string) => void,
  opts: { scratchDir: string; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> }
): Promise<InstallResult> {
  return exclusive(log, async () => {
    if (process.platform === 'win32')
      return {
        ok: false,
        error: 'Install Claude Code from PowerShell: irm https://claude.ai/install.ps1 | iex — then Check again.'
      }
    log(`Downloading ${INSTALL_SCRIPT_URL}…`)
    const res = await (opts.fetchImpl ?? fetch)(INSTALL_SCRIPT_URL, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return { ok: false, error: `Downloading the installer failed (${res.status}).` }
    const script = await res.text()
    if (script.length > MAX_SCRIPT_BYTES || !script.startsWith('#!'))
      return { ok: false, error: 'The installer download does not look like a shell script.' }
    const path = join(opts.scratchDir, 'claude-install.sh')
    await writeFile(path, script, { mode: 0o600 })
    try {
      const code = await stream('/bin/bash', [path, 'latest'], installerEnv(process.env), log)
      if (code !== 0) return { ok: false, error: `The Claude Code installer failed (exit ${code}); see the log.` }
      log(`Done. Next: sign in once in a terminal with \`${CLAUDE_COMMANDS.login}\`, then Check again.`)
      return { ok: true }
    } finally {
      await rm(path, { force: true })
    }
  })
}

/** `claude update` for native and npm installs; the brew command for Homebrew; a fresh native install otherwise. */
export function updateClaude(
  log: (line: string) => void,
  opts: { claudePath: string; kind: ClaudeInstallKind; scratchDir: string }
): Promise<InstallResult> {
  if (opts.kind === 'homebrew')
    return Promise.resolve({
      ok: false,
      error: `Claude Code was installed with Homebrew. Run \`${CLAUDE_COMMANDS.brewUpgrade}\` in a terminal, then Check again.`
    })
  // A native install lands in ~/.local/bin, which is looked up first, so it shadows an unknown older copy.
  if (opts.kind === 'other') return installClaude(log, { scratchDir: opts.scratchDir })
  return exclusive(log, async () => {
    const code = await stream(opts.claudePath, ['update'], installerEnv(process.env), log)
    if (code !== 0) return { ok: false, error: `claude update failed (exit ${code}); see the log.` }
    log('Done.')
    return { ok: true }
  })
}
