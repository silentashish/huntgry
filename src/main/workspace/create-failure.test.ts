import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_FILE, COVER_LETTER_FILE, MASTER_PROFILE_FILE } from './constants'

// Fail the write of one chosen file, or swap the new root for a symlink right after
// mkdir (a race with another process); every other fs call is the real one.
const failOn = vi.hoisted(() => ({ name: null as string | null, swapTo: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    writeFile: (async (path, ...rest) => {
      if (failOn.name && String(path).endsWith(`/${failOn.name}`)) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
      return real.writeFile(path, ...rest)
    }) as typeof real.writeFile,
    mkdir: (async (path, options) => {
      const out = await real.mkdir(path, options)
      if (failOn.swapTo) {
        await real.rmdir(path)
        await real.symlink(failOn.swapTo, path)
      }
      return out
    }) as typeof real.mkdir
  }
})

const { createWorkspace } = await import('./create')

let tmp: string

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'huntgry-fail-')))
})

afterEach(async () => {
  failOn.name = null
  failOn.swapTo = null
  await rm(tmp, { recursive: true, force: true })
})

describe('createWorkspace failure handling', () => {
  it.each([CLAUDE_FILE, COVER_LETTER_FILE, MASTER_PROFILE_FILE])(
    'rolls back a missing-dir create when writing %s fails',
    async (name) => {
      failOn.name = name
      const root = join(tmp, 'new-ws')
      const r = await createWorkspace(root)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/ENOSPC/)
      expect(r.created).toEqual([])
      expect(r.inspection.status).toBe('missing')
      expect(await readdir(tmp)).toEqual([])
    }
  )

  it('rolls back an empty-dir create to the empty state, so a retry works', async () => {
    failOn.name = MASTER_PROFILE_FILE
    const r = await createWorkspace(tmp)
    expect(r.ok).toBe(false)
    expect(r.inspection.status).toBe('empty')
    expect(await readdir(tmp)).toEqual([])

    failOn.name = null
    const retry = await createWorkspace(tmp)
    expect(retry.ok).toBe(true)
    expect(retry.inspection.status).toBe('valid')
  })

  it('writes nothing when the new root is swapped for a symlink after mkdir', async () => {
    const elsewhere = join(tmp, 'elsewhere')
    await mkdir(elsewhere)
    failOn.swapTo = elsewhere
    const r = await createWorkspace(join(tmp, 'new-ws'))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ECHANGED/)
    expect(await readdir(elsewhere)).toEqual([])
  })
})
