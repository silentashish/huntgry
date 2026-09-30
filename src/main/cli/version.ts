import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'

/**
 * The `claude` CLI version and the flags it supports. Homebrew, npm and WinGet
 * installs do not auto-update, so the app must work with older versions and
 * only pass newer flags when the binary knows them.
 */

/** First version that accepts `--permission-prompts none` (Claude Code CHANGELOG 2.1.259). */
export const CLAUDE_VERSION_PERMISSION_PROMPTS = '2.1.259'

/** Settings nudges older installs to update to at least this version. */
export const CLAUDE_VERSION_RECOMMENDED = CLAUDE_VERSION_PERMISSION_PROMPTS

/** `2.1.285 (Claude Code)` → `2.1.285`; `null` when there is no `x.y.z` on the first line. */
export function parseClaudeVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output.trim().split('\n')[0] ?? '')
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** Numeric compare of `x.y.z` versions (a `-pre` suffix is ignored). Unparseable parts count as 0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** `version` is at least `min`; an unknown version never is. */
export function versionAtLeast(version: string | null, min: string): boolean {
  const v = version ? parseClaudeVersion(version) : null
  return v !== null && compareVersions(v, min) >= 0
}

/** Whether `--permission-prompts none` may be passed. Unknown version = no (the run still works without it). */
export function supportsPermissionPrompts(version: string | null): boolean {
  return versionAtLeast(version, CLAUDE_VERSION_PERMISSION_PROMPTS)
}

const VERSION_TIMEOUT_MS = 20_000
const cache = new Map<string, Promise<string | null>>()

/**
 * `claude --version`, parsed, once per binary. Keyed by the real path: the
 * native launcher is a symlink into `versions/<v>`, so an update changes the
 * key and the cache invalidates itself. `null` when it fails or hangs.
 */
export async function claudeVersion(claudePath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const key = await realpath(claudePath).catch(() => claudePath)
  let pending = cache.get(key)
  if (!pending) {
    pending = new Promise((resolve) => {
      execFile(claudePath, ['--version'], { env, timeout: VERSION_TIMEOUT_MS, maxBuffer: 1 << 16 }, (err, stdout) =>
        resolve(err ? null : parseClaudeVersion(stdout))
      )
    })
    cache.set(key, pending)
    // A failure (hang, crash) is not cached, so Settings → Check again retries it.
    void pending.then((v) => {
      if (v === null) cache.delete(key)
    })
  }
  return pending
}

/** Tests only. */
export function clearClaudeVersionCache(): void {
  cache.clear()
}

/** `error: unknown option '--x'` in a failed run's stderr → a message that says what to do. */
export function explainClaudeError(stderr: string, version: string | null): string | null {
  const m = /unknown option '--([\w-]+)'/.exec(stderr)
  if (!m) return null
  return `Your Claude Code${version ? ` (${version})` : ''} does not support --${m[1]}. Update Claude Code from Settings, then try again.`
}
