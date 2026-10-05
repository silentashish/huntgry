import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeDurable } from './durable'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-durable-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('writeDurable', () => {
  it('fsyncs the temp file before the rename and the directory after it, leaving no temp file', async () => {
    const probe = await open(join(dir, 'probe'), 'w')
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    const sync = vi.spyOn(proto, 'sync')
    await writeDurable(join(dir, 'devices.json'), '{"outSeq":7}\n')
    // One sync for the data, one for the directory entry (on platforms that allow it).
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(process.platform === 'win32' ? 1 : 2)
    expect(await readFile(join(dir, 'devices.json'), 'utf8')).toBe('{"outSeq":7}\n')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('rejects, and leaves the old content, when the data cannot be synced', async () => {
    await writeDurable(join(dir, 'devices.json'), 'old\n')
    const probe = await open(join(dir, 'probe'), 'w')
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    vi.spyOn(proto, 'sync').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }))
    await expect(writeDurable(join(dir, 'devices.json'), 'new\n')).rejects.toThrow('EIO')
    expect(await readFile(join(dir, 'devices.json'), 'utf8')).toBe('old\n')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
