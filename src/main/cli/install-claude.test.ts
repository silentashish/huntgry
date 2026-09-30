import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkEnvironment } from './environment'
import {
  installClaude,
  installKindOf,
  NOT_SIGNED_IN,
  parseAuthStatus,
  requireSignedIn,
  updateClaude
} from './install-claude'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'huntgry-install-claude-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('claude install kind', () => {
  it('tells native, Homebrew and npm installs apart by real path', () => {
    expect(installKindOf('/Users/a/.local/share/claude/versions/2.1.285')).toBe('native')
    expect(installKindOf('/Users/a/.claude/local/node_modules/.bin/claude')).toBe('native')
    expect(installKindOf('/opt/homebrew/Caskroom/claude-code/2.1.231/claude')).toBe('homebrew')
    expect(installKindOf('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('npm')
    expect(installKindOf('/usr/local/bin/claude')).toBe('other')
  })
})

describe('claude auth status', () => {
  it('reads signed-in and signed-out JSON', () => {
    const inJson = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'pro' })
    expect(parseAuthStatus(0, inJson)).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'a@b.c',
      subscriptionType: 'pro'
    })
    expect(parseAuthStatus(1, JSON.stringify({ loggedIn: false, authMethod: 'none' }))).toEqual({
      loggedIn: false,
      authMethod: 'none',
      email: undefined,
      subscriptionType: undefined
    })
  })

  it('returns null when it cannot tell (old CLI, garbage, crash)', () => {
    expect(parseAuthStatus(1, "error: unknown command 'auth'")).toBeNull()
    expect(parseAuthStatus(0, '{nope')).toBeNull()
    expect(parseAuthStatus(1, 'Not logged in')).toEqual({ loggedIn: false })
  })
})

describe.skipIf(process.platform === 'win32')('installClaude', () => {
  it('runs the downloaded installer with target latest and removes it afterwards', async () => {
    const log: string[] = []
    const script = '#!/bin/bash\necho "installing $1"\necho "✅ Installation complete!"\n'
    const res = await installClaude((l) => log.push(l), {
      scratchDir: tmp,
      fetchImpl: async () => new Response(script, { status: 200 })
    })
    expect(res).toEqual({ ok: true })
    expect(log).toContain('installing latest')
    expect(await readdir(tmp)).toEqual([])
  })

  it('refuses something that is not a shell script, and reports a failing installer', async () => {
    const html = await installClaude(() => {}, {
      scratchDir: tmp,
      fetchImpl: async () => new Response('<html>captive portal</html>', { status: 200 })
    })
    expect(html).toMatchObject({ ok: false, error: expect.stringContaining('shell script') })
    const huge = await installClaude(() => {}, {
      scratchDir: tmp,
      fetchImpl: async () => new Response(new Uint8Array(2 * 1024 * 1024).fill(35), { status: 200 })
    })
    expect(huge).toMatchObject({ ok: false, error: expect.stringContaining('unexpectedly large') })
    expect(await readdir(tmp)).toEqual([])
    const failing = await installClaude(() => {}, {
      scratchDir: tmp,
      fetchImpl: async () => new Response('#!/bin/bash\nexit 7\n', { status: 200 })
    })
    expect(failing).toMatchObject({ ok: false, error: expect.stringContaining('exit 7') })
  })

  it('never runs brew; Homebrew installs get the command', async () => {
    const res = await updateClaude(() => {}, { claudePath: '/nope', kind: 'homebrew', scratchDir: tmp })
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('brew upgrade claude-code') })
  })
})

describe.skipIf(process.platform === 'win32')('checkEnvironment', () => {
  it('blocks a signed-out Claude Code and only warns about an old version', async () => {
    const fake = join(tmp, 'claude')
    await writeFile(
      fake,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.231 (Claude Code)"; exit 0; fi\n' +
        'if [ "$1" = "auth" ]; then echo \'{"loggedIn": false, "authMethod": "none"}\'; exit 1; fi\nexit 2\n'
    )
    await chmod(fake, 0o755)
    const before = process.env.HUNTGRY_CLAUDE_PATH
    process.env.HUNTGRY_CLAUDE_PATH = fake
    try {
      const env = await checkEnvironment({ venvDir: join(tmp, 'venv'), workspace: null })
      expect(env.claudePath).toBe(fake)
      expect(env).toMatchObject({
        claudeVersion: '2.1.231',
        claudeVersionOk: false,
        claudeInstallKind: 'other',
        claudeAuth: { loggedIn: false }
      })
      expect(env.problems.some((p) => p.includes('not signed in'))).toBe(true)
      expect(env.problems.some((p) => p.includes('older'))).toBe(false)
      expect(env.warnings[0]).toContain('2.1.231 is older than 2.1.259')
      expect(env.ready).toBe(false)
    } finally {
      if (before === undefined) delete process.env.HUNTGRY_CLAUDE_PATH
      else process.env.HUNTGRY_CLAUDE_PATH = before
    }
  }, 30_000)
})

describe.skipIf(process.platform === 'win32')('requireSignedIn (checked in main before every spawn)', () => {
  const fake = async (auth: string, code: number) => {
    const path = join(tmp, `claude-${code}-${auth.length}`)
    await writeFile(path, `#!/bin/sh\necho '${auth}'\nexit ${code}\n`)
    await chmod(path, 0o755)
    return path
  }

  it('refuses a signed-out CLI so no run is created', async () => {
    const out = await fake('{"loggedIn": false, "authMethod": "none"}', 1)
    await expect(requireSignedIn(out, { ...process.env })).rejects.toThrow(NOT_SIGNED_IN)
  })

  it('lets a signed-in CLI and an unknown state through', async () => {
    await expect(requireSignedIn(await fake('{"loggedIn": true}', 0), { ...process.env })).resolves.toBeUndefined()
    await expect(requireSignedIn(await fake("error: unknown command 'auth'", 1), { ...process.env })).resolves.toBeUndefined()
  })
})
