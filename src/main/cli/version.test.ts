import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeVersion,
  clearClaudeVersionCache,
  compareVersions,
  explainClaudeError,
  parseClaudeVersion,
  supportsPermissionPrompts,
  versionAtLeast
} from './version'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'huntgry-version-'))
  clearClaudeVersionCache()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('claude version', () => {
  it('parses `claude --version` output', () => {
    expect(parseClaudeVersion('2.1.285 (Claude Code)\n')).toBe('2.1.285')
    expect(parseClaudeVersion('claude 10.0.3-beta.1')).toBe('10.0.3')
    expect(parseClaudeVersion('')).toBeNull()
    expect(parseClaudeVersion('garbage\n2.1.0')).toBeNull()
  })

  it('compares versions numerically', () => {
    expect(compareVersions('2.1.259', '2.1.259')).toBe(0)
    expect(compareVersions('2.1.231', '2.1.259')).toBe(-1)
    expect(compareVersions('2.2.0', '2.1.999')).toBe(1)
    expect(compareVersions('10.0.0', '9.9.9')).toBe(1)
    expect(compareVersions('2.1.259-beta', '2.1.259')).toBe(0)
    expect(versionAtLeast('2.1.285 (Claude Code)', '2.1.259')).toBe(true)
  })

  it('passes --permission-prompts only from 2.1.259, never for an unknown version', () => {
    expect(supportsPermissionPrompts('2.1.259')).toBe(true)
    expect(supportsPermissionPrompts('2.1.285')).toBe(true)
    expect(supportsPermissionPrompts('2.1.231')).toBe(false)
    expect(supportsPermissionPrompts('1.0.0')).toBe(false)
    expect(supportsPermissionPrompts(null)).toBe(false)
    expect(supportsPermissionPrompts('unknown')).toBe(false)
  })

  it('explains an unknown-option failure', () => {
    const msg = explainClaudeError("error: unknown option '--permission-prompts'", '2.1.231')
    expect(msg).toContain('2.1.231')
    expect(msg).toContain('--permission-prompts')
    expect(msg).toContain('Update Claude Code')
    expect(explainClaudeError('boom', '2.1.231')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('runs --version once per real binary', async () => {
    const counter = join(tmp, 'count')
    const script = (v: string) => `#!/bin/sh\necho x >> "${counter}"\necho "${v} (Claude Code)"\n`
    const v1 = join(tmp, 'v1')
    const v2 = join(tmp, 'v2')
    await writeFile(v1, script('2.1.231'))
    await writeFile(v2, script('2.1.285'))
    await chmod(v1, 0o755)
    await chmod(v2, 0o755)
    const link = join(tmp, 'claude')
    await symlink(v1, link)
    const env = { ...process.env }
    expect(await claudeVersion(link, env)).toBe('2.1.231')
    expect(await claudeVersion(link, env)).toBe('2.1.231')
    // An update swaps the launcher's target: the new binary is asked again.
    await symlink(v2, `${link}.new`)
    await rename(`${link}.new`, link)
    expect(await claudeVersion(link, env)).toBe('2.1.285')
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('returns null for a binary that fails', async () => {
    expect(await claudeVersion(join(tmp, 'missing'), { ...process.env })).toBeNull()
  })
})
