import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { remoteFile, workspaceIdentity } from './workspace'

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-wsid-'))
})
afterEach(() => rm(ws, { recursive: true, force: true }))

describe('workspaceIdentity', () => {
  it('mints a random id once, keeps it in .huntgry/remote.json and names the workspace by its folder', async () => {
    const a = await workspaceIdentity(ws)
    expect(a.id).toMatch(/^[0-9a-f]{32}$/)
    expect(a.name).toBe(basename(ws))
    expect(JSON.parse(await readFile(remoteFile(ws), 'utf8'))).toEqual({ version: 1, workspaceId: a.id })
    expect((await workspaceIdentity(ws)).id).toBe(a.id)
    const other = await mkdtemp(join(tmpdir(), 'huntgry-wsid-'))
    expect((await workspaceIdentity(other)).id).not.toBe(a.id)
    await rm(other, { recursive: true, force: true })
  })

  it('replaces a broken file with a new id', async () => {
    await workspaceIdentity(ws)
    await writeFile(remoteFile(ws), '{"workspaceId":"../../etc"}')
    expect((await workspaceIdentity(ws)).id).toMatch(/^[0-9a-f]{32}$/)
  })
})
