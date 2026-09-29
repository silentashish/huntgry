import { chmod, mkdir, mkdtemp, readdir, readFile, lstat, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isProfileEmpty } from '@shared/master-profile'
import { canImport, createMode } from '@shared/workspace-types'
import { parseMasterProfile } from '../profile/format'
import { CLAUDE_FILE, COVER_LETTER_FILE, MASTER_PROFILE_FILE, MAX_SCAN_ENTRIES } from './constants'
import {
  createWorkspace,
  inspectWorkspace,
  loadSettings,
  normalizeInputPath,
  openWorkspace,
  saveSettings
} from './index'
import { readEntriesBounded } from './inspect'

let tmp: string

beforeEach(async () => {
  // realpath: macOS tmpdir lives behind the /var -> /private/var symlink.
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'huntgry-ws-')))
})

afterEach(async () => {
  // Restore permissions changed by tests so cleanup succeeds.
  await chmod(tmp, 0o700).catch(() => {})
  await rm(tmp, { recursive: true, force: true })
})

async function write(path: string, content = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** Recreates the user's real `~/cv` shape: application folders, no master profile. */
async function legacyFixture(root: string): Promise<void> {
  await write(join(root, 'software-engineer/midpage/d28b6f48/job-description.md'), '# JD')
}

async function v3Fixture(root: string): Promise<void> {
  await write(join(root, MASTER_PROFILE_FILE), '# Me')
  await write(join(root, COVER_LETTER_FILE), 'Dear')
  await write(join(root, 'backend-engineer/acme/123/resume_data.json'), '{}')
  await write(join(root, 'backend-engineer/acme/123/resume.pdf'), '%PDF')
}

/** path -> size/mtime/content for every entry, without following symlinks. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      const s = await lstat(p)
      const content = e.isFile() ? (await readFile(p)).toString('base64') : ''
      out[relative(root, p)] = `${s.mode}:${s.size}:${s.mtimeMs}:${content}`
      if (e.isDirectory()) await walk(p)
    }
  }
  const s = await lstat(root)
  out['.'] = `${s.mode}:${s.mtimeMs}`
  await walk(root)
  return out
}

const isRoot = process.getuid?.() === 0

describe('inspectWorkspace', () => {
  it('returns missing for a non-existent path whose parent is writable (AC6)', async () => {
    const r = await inspectWorkspace(join(tmp, 'new-ws'))
    expect(r.status).toBe('missing')
    expect(r.path).toBe(join(tmp, 'new-ws'))
    expect(r.errors).toEqual([])
  })

  it('returns empty for an empty dir and for one holding only .DS_Store/.git (AC7)', async () => {
    const empty = join(tmp, 'empty')
    await mkdir(empty)
    expect((await inspectWorkspace(empty)).status).toBe('empty')

    const noise = join(tmp, 'noise')
    await write(join(noise, '.DS_Store'))
    await write(join(noise, '.git/HEAD'), 'ref: refs/heads/main')
    expect((await inspectWorkspace(noise)).status).toBe('empty')
  })

  it('returns valid with layout v3 when master-profile.md exists (AC8)', async () => {
    await v3Fixture(tmp)
    const r = await inspectWorkspace(tmp)
    expect(r).toMatchObject({
      status: 'valid',
      layout: 'v3',
      masterProfile: MASTER_PROFILE_FILE,
      applicationCount: 1,
      errors: []
    })
  })

  it('matches the master profile name case-insensitively', async () => {
    await write(join(tmp, 'Master-Profile.md'))
    const r = await inspectWorkspace(tmp)
    expect(r.status).toBe('valid')
    expect(r.masterProfile).toBe('Master-Profile.md')
  })

  it('returns legacy for master_profile.md (AC9)', async () => {
    await write(join(tmp, 'master_profile.md'))
    const r = await inspectWorkspace(tmp)
    expect(r).toMatchObject({ status: 'legacy', layout: 'legacy', masterProfile: 'master_profile.md' })
  })

  it('returns legacy with a warning for application folders without a profile, like today’s ~/cv (AC9)', async () => {
    await legacyFixture(tmp)
    const r = await inspectWorkspace(tmp)
    expect(r).toMatchObject({ status: 'legacy', masterProfile: null, applicationCount: 1 })
    expect(r.warnings.join(' ')).toMatch(/No master profile found/)
  })

  it('returns not-a-workspace for a non-empty unrelated dir (AC10)', async () => {
    await write(join(tmp, 'notes.txt'))
    await write(join(tmp, 'photos/2024/june/img.jpg'))
    const r = await inspectWorkspace(tmp)
    expect(r.status).toBe('not-a-workspace')
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('returns invalid with a reason for a file, a missing parent and a relative path (AC10)', async () => {
    const file = join(tmp, 'file.md')
    await write(file)
    for (const p of [file, join(tmp, 'nope', 'child'), 'relative/path']) {
      const r = await inspectWorkspace(p)
      expect(r.status, p).toBe('invalid')
      expect(r.errors.length, p).toBeGreaterThan(0)
    }
  })

  it.skipIf(isRoot)('returns invalid for an unwritable dir and for a missing path under one (AC10)', async () => {
    const locked = join(tmp, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)
    try {
      const r = await inspectWorkspace(locked)
      expect(r.status).toBe('invalid')
      expect(r.errors[0]).toMatch(/permission denied/)
      expect((await inspectWorkspace(join(locked, 'child'))).status).toBe('invalid')
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('does not follow symlinks while scanning and survives a symlink loop (AC15)', async () => {
    const outside = join(tmp, 'outside')
    await legacyFixture(outside)
    const ws = join(tmp, 'ws')
    await write(join(ws, MASTER_PROFILE_FILE))
    await symlink(ws, join(ws, 'loop')) // loop back to the root
    await symlink(join(outside, 'software-engineer'), join(ws, 'linked-role')) // would add 1 app if followed
    await mkdir(join(ws, 'role/company'), { recursive: true })
    await symlink(join(outside, 'software-engineer/midpage/d28b6f48'), join(ws, 'role/company/job'))

    const r = await inspectWorkspace(ws)
    expect(r.status).toBe('valid')
    expect(r.applicationCount).toBe(0)
  })

  it('ignores a dangling master-profile.md symlink', async () => {
    const ws = join(tmp, 'ws')
    await mkdir(ws)
    await symlink(join(tmp, 'nowhere.md'), join(ws, MASTER_PROFILE_FILE))
    const r = await inspectWorkspace(ws)
    expect(r).toMatchObject({ status: 'not-a-workspace', masterProfile: null })
    expect(r.warnings.join(' ')).toMatch(/target does not exist/)
  })

  it('ignores a master-profile.md symlink that points to a directory', async () => {
    const ws = join(tmp, 'ws')
    await mkdir(join(tmp, 'some-dir'))
    await mkdir(ws)
    await symlink(join(tmp, 'some-dir'), join(ws, MASTER_PROFILE_FILE))
    const r = await inspectWorkspace(ws)
    expect(r).toMatchObject({ status: 'not-a-workspace', masterProfile: null })
    expect(r.warnings.join(' ')).toMatch(/does not point to a regular file/)
  })

  it('ignores a directory named master-profile.md and falls back to the legacy file', async () => {
    const ws = join(tmp, 'ws')
    await mkdir(join(ws, MASTER_PROFILE_FILE), { recursive: true })
    await write(join(ws, 'master_profile.md'), '# old')
    const r = await inspectWorkspace(ws)
    expect(r).toMatchObject({ status: 'legacy', masterProfile: 'master_profile.md' })
    expect(r.warnings.join(' ')).toMatch(/is not a file/)
  })

  it('accepts a master-profile.md symlink to a readable file outside the workspace, with a warning', async () => {
    const external = join(tmp, 'dotfiles', 'profile.md')
    await write(external, '# Me')
    const ws = join(tmp, 'ws')
    await mkdir(ws)
    await symlink(external, join(ws, MASTER_PROFILE_FILE))
    const r = await inspectWorkspace(ws)
    expect(r).toMatchObject({ status: 'valid', masterProfile: MASTER_PROFILE_FILE })
    expect(r.warnings.join(' ')).toContain(`symlink to ${external}`)
  })

  it.skipIf(isRoot)('ignores an unreadable master-profile.md', async () => {
    const ws = join(tmp, 'ws')
    await write(join(ws, MASTER_PROFILE_FILE), '# Me')
    await chmod(join(ws, MASTER_PROFILE_FILE), 0o000)
    const r = await inspectWorkspace(ws)
    expect(r).toMatchObject({ status: 'not-a-workspace', masterProfile: null })
    expect(r.warnings.join(' ')).toMatch(/not readable/)
  })

  it('returns invalid (not missing) for a dangling symlink root, and Create writes nothing', async () => {
    const link = join(tmp, 'dangling')
    await symlink(join(tmp, 'gone'), link)
    const r = await inspectWorkspace(link)
    expect(r.status).toBe('invalid')
    expect(r.errors[0]).toMatch(/symlink whose target does not exist/)

    const before = await snapshot(tmp)
    const c = await createWorkspace(link)
    expect(c.ok).toBe(false)
    expect(c.inspection.status).toBe('invalid')
    expect(await snapshot(tmp)).toEqual(before)
  })

  it('resolves a symlinked root to its real path', async () => {
    const real = join(tmp, 'real')
    await write(join(real, MASTER_PROFILE_FILE))
    await symlink(real, join(tmp, 'alias'))
    const r = await inspectWorkspace(join(tmp, 'alias'))
    expect(r.status).toBe('valid')
    expect(r.path).toMatch(/real$/)
  })

  it('bounds the scan and reports truncation (AC15)', async () => {
    await write(join(tmp, MASTER_PROFILE_FILE))
    const big = join(tmp, 'big')
    await mkdir(big)
    await Promise.all(
      Array.from({ length: MAX_SCAN_ENTRIES + 10 }, (_, i) => writeFile(join(big, `f${i}`), ''))
    )
    const r = await inspectWorkspace(tmp)
    expect(r.status).toBe('valid')
    expect(r.warnings.join(' ')).toMatch(/Scan stopped/)
  })
})

describe('bounded directory reads (AC15)', () => {
  it('readEntriesBounded stops reading once the budget is spent', async () => {
    const dir = join(tmp, 'many')
    await mkdir(dir)
    await Promise.all(Array.from({ length: 300 }, (_, i) => writeFile(join(dir, `f${i}`), '')))

    const small = { remaining: 50, exhausted: false }
    expect(await readEntriesBounded(dir, small)).toHaveLength(50)
    expect(small).toEqual({ remaining: 0, exhausted: true })

    const exact = { remaining: 300, exhausted: false }
    expect(await readEntriesBounded(dir, exact)).toHaveLength(300)
    expect(exact.exhausted).toBe(false)
  })

  it('caps the root listing too and still finds the master profile by direct lookup', async () => {
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(join(tmp, `junk${i}`), '')))
    await write(join(tmp, MASTER_PROFILE_FILE))
    const r = await inspectWorkspace(tmp, { maxEntries: 20 })
    expect(r).toMatchObject({ status: 'valid', masterProfile: MASTER_PROFILE_FILE })
    expect(r.warnings.join(' ')).toMatch(/Scan stopped after 20 entries/)
  })

  it('keeps application folders already found when the budget runs out (no profile)', async () => {
    for (let i = 0; i < 10; i++) await write(join(tmp, `role${i}/co/job/job-description.md`))
    // root listing costs 10, each application folder costs 3 more (role, company, job-id reads)
    const r = await inspectWorkspace(tmp, { maxEntries: 25 })
    expect(r.applicationCount).toBe(5)
    expect(r.status).toBe('legacy')
    expect(r.warnings.join(' ')).toMatch(/Scan stopped/)
  })

  it('returns unverified, not not-a-workspace, when the scan stops before finding anything', async () => {
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(tmp, `junk${i}`), '')))
    const r = await inspectWorkspace(tmp, { maxEntries: 20 })
    expect(r.status).toBe('unverified')
    expect(r.errors[0]).toMatch(/Scan stopped after 20 entries/)
  })

  it('shares one budget between the root and nested application folders', async () => {
    await write(join(tmp, 'master_profile.md'))
    for (let i = 0; i < 10; i++) await write(join(tmp, `role${i}/co/job/job-description.md`))
    expect((await inspectWorkspace(tmp)).applicationCount).toBe(10)
    const capped = await inspectWorkspace(tmp, { maxEntries: 25 })
    expect(capped.status).toBe('legacy')
    expect(capped.applicationCount).toBeLessThan(10)
    expect(capped.warnings.join(' ')).toMatch(/Scan stopped/)
  })
})

describe('createWorkspace', () => {
  async function expectSkeleton(root: string): Promise<void> {
    const profile = await readFile(join(root, MASTER_PROFILE_FILE), 'utf8')
    expect(isProfileEmpty(parseMasterProfile(profile).profile)).toBe(true)
    for (const section of [
      'Contact',
      'Summary',
      'Experience',
      'Education',
      'Skills',
      'Projects',
      'Certifications',
      'Publications',
      'Gaps and constraints'
    ]) {
      expect(profile).toContain(`## ${section}`)
    }
    await expect(readFile(join(root, COVER_LETTER_FILE), 'utf8')).resolves.toContain('Cover Letter')
    const claude = await readFile(join(root, CLAUDE_FILE), 'utf8')
    expect(claude).toContain(`CV_HOME: \`${root}\``)
    expect(claude).toContain(`--cv-home "${root}"`)
    expect(claude).toContain(MASTER_PROFILE_FILE)
    expect(claude).not.toContain('{{')
  }

  it('creates a missing directory and the skeleton, then inspects as valid (AC11)', async () => {
    const root = join(tmp, 'new-ws')
    const r = await createWorkspace(root)
    expect(r.ok).toBe(true)
    expect(r.created).toEqual(['.', MASTER_PROFILE_FILE, COVER_LETTER_FILE, CLAUDE_FILE])
    expect(r.skipped).toEqual([])
    expect(r.inspection.status).toBe('valid')
    expect(canImport(r.inspection)).toBe(true)
    await expectSkeleton(root)
    expect((await inspectWorkspace(root)).status).toBe('valid')
  })

  it('initialises an empty dir and leaves ignorable entries untouched (AC12)', async () => {
    await write(join(tmp, '.DS_Store'), 'finder-bytes')
    await write(join(tmp, '.git/HEAD'), 'ref: refs/heads/main')
    const before = await snapshot(tmp)

    const r = await createWorkspace(tmp)
    expect(r.ok).toBe(true)
    expect(r.created).toEqual([MASTER_PROFILE_FILE, COVER_LETTER_FILE, CLAUDE_FILE])
    await expectSkeleton(tmp)

    const after = await snapshot(tmp)
    for (const key of ['.DS_Store', '.git', join('.git', 'HEAD')]) {
      expect(after[key], key).toBe(before[key])
    }
  })

  it.each([
    ['valid', v3Fixture],
    ['legacy', async (root: string) => write(join(root, 'master_profile.md'), '# old')]
  ] as const)('refuses a %s dir that already has a master profile, even when confirmed', async (status, fixture) => {
    await fixture(tmp)
    const before = await snapshot(tmp)
    for (const allowNonEmpty of [false, true]) {
      const r = await createWorkspace(tmp, { allowNonEmpty })
      expect(r).toMatchObject({ ok: false, created: [], skipped: [] })
      expect(r.needsConfirmation).toBeUndefined()
      expect(r.inspection.status).toBe(status)
      expect(r.error).toMatch(/already has a master profile.*Import/)
    }
    expect(await snapshot(tmp)).toEqual(before)
  })

  it.each([
    ['legacy', legacyFixture],
    ['not-a-workspace', async (root: string) => write(join(root, 'notes.txt'), 'mine')]
  ] as const)('asks for confirmation before adding a workspace to a non-empty %s dir', async (status, fixture) => {
    await fixture(tmp)
    const before = await snapshot(tmp)
    const r = await createWorkspace(tmp)
    expect(r).toMatchObject({ ok: false, needsConfirmation: true, created: [] })
    expect(r.inspection.status).toBe(status)
    expect(await snapshot(tmp)).toEqual(before)
  })

  it.each([
    ['legacy', legacyFixture],
    ['not-a-workspace', async (root: string) => write(join(root, 'notes.txt'), 'mine')]
  ] as const)('adds the workspace to a confirmed %s dir without touching existing files', async (_status, fixture) => {
    await fixture(tmp)
    const before = await snapshot(tmp)
    const r = await createWorkspace(tmp, { allowNonEmpty: true })
    expect(r.ok).toBe(true)
    expect(r.created).toEqual([MASTER_PROFILE_FILE, COVER_LETTER_FILE, CLAUDE_FILE])
    expect(r.inspection.status).toBe('valid')
    await expectSkeleton(tmp)
    const after = await snapshot(tmp)
    for (const [key, value] of Object.entries(before)) {
      if (key !== '.') expect(after[key], key).toBe(value)
    }
  })

  it('skips skeleton files that already exist and reports them', async () => {
    await write(join(tmp, CLAUDE_FILE), 'my own instructions')
    const r = await createWorkspace(tmp, { allowNonEmpty: true })
    expect(r.ok).toBe(true)
    expect(r.created).toEqual([MASTER_PROFILE_FILE, COVER_LETTER_FILE])
    expect(r.skipped).toEqual([CLAUDE_FILE])
    expect(await readFile(join(tmp, CLAUDE_FILE), 'utf8')).toBe('my own instructions')
  })

  it('fails when something that is not a file already uses the master profile name', async () => {
    await mkdir(join(tmp, MASTER_PROFILE_FILE))
    const r = await createWorkspace(tmp, { allowNonEmpty: true })
    expect(r.ok).toBe(false)
    expect(r.skipped).toContain(MASTER_PROFILE_FILE)
    expect(r.error).toMatch(/already uses that name/)
  })

  it('refuses invalid targets and writes nothing (AC13)', async () => {
    const file = join(tmp, 'file.md')
    await write(file, 'keep me')
    const before = await snapshot(tmp)
    for (const p of [file, join(tmp, 'nope', 'child')]) {
      const r = await createWorkspace(p)
      expect(r.ok, p).toBe(false)
      expect(r.inspection.status, p).toBe('invalid')
    }
    expect(await snapshot(tmp)).toEqual(before)
  })
})

describe('openWorkspace (Import)', () => {
  it.each([
    ['v3', v3Fixture, 'valid'],
    ['legacy', legacyFixture, 'legacy']
  ] as const)('performs zero writes on a %s workspace (AC14)', async (_name, fixture, status) => {
    await fixture(tmp)
    const before = await snapshot(tmp)
    const r = await openWorkspace(tmp)
    expect(r.status).toBe(status)
    expect(await snapshot(tmp)).toEqual(before)
  })
})

describe('canImport / createMode', () => {
  it('imports only folders with a master profile and offers Create for the rest', async () => {
    const v3 = join(tmp, 'v3')
    await v3Fixture(v3)
    const oldName = join(tmp, 'old-name')
    await write(join(oldName, 'master_profile.md'), '# old')
    const appsOnly = join(tmp, 'apps-only')
    await legacyFixture(appsOnly)
    const other = join(tmp, 'other')
    await write(join(other, 'notes.txt'))
    const empty = join(tmp, 'empty')
    await mkdir(empty)

    const cases: Array<[string, boolean, ReturnType<typeof createMode>]> = [
      [v3, true, null],
      [oldName, true, null],
      [appsOnly, false, 'confirm'],
      [other, false, 'confirm'],
      [empty, false, 'direct'],
      [join(tmp, 'missing'), false, 'direct'],
      [join(tmp, 'nope', 'child'), false, null]
    ]
    for (const [path, importable, mode] of cases) {
      const r = await inspectWorkspace(path)
      expect(canImport(r), path).toBe(importable)
      expect(createMode(r), path).toBe(mode)
    }
  })
})

describe('normalizeInputPath', () => {
  it('expands ~, resolves absolute paths and rejects everything else', () => {
    expect(normalizeInputPath('~/cv', '/home/me')).toBe(join('/home/me', 'cv'))
    expect(normalizeInputPath('~', '/home/me')).toBe('/home/me')
    expect(normalizeInputPath('  /tmp/a/../b  ')).toBe('/tmp/b')
    for (const bad of ['', '   ', 'relative', 42, null, undefined, '/tmp/\0x', '~user/cv']) {
      expect(normalizeInputPath(bad), String(bad)).toBeNull()
    }
  })
})

describe('settings', () => {
  it('round-trips the current workspace and tolerates a missing or corrupt file', async () => {
    const file = join(tmp, 'settings.json')
    expect(await loadSettings(file)).toEqual({})
    await saveSettings(file, { currentWorkspace: '/some/ws' })
    expect(await loadSettings(file)).toEqual({ currentWorkspace: '/some/ws' })
    await writeFile(file, '{not json')
    expect(await loadSettings(file)).toEqual({})
  })
})
