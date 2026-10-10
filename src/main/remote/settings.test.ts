import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRemoteSettings, remoteSettingsOf, updateRemoteSettings } from './settings'

/** Remote settings in `userData/settings.json` next to `defaultAgent` (#37). */

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-remote-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(async () => rm(dir, { recursive: true, force: true }))

describe('remote settings', () => {
  it('defaults: off, details off, transcripts on, TTLs 2 h / 24 h', async () => {
    expect(await readRemoteSettings(file)).toEqual({ enabled: false, notificationDetails: false, transcripts: true, commandTtl: { costly: 7200, default: 86400 } })
  })

  it('persists the toggles and TTLs under "remote", next to defaultAgent, keeping every other setting', async () => {
    await writeFile(file, JSON.stringify({ defaultAgent: 'codex', currentWorkspace: '/w', remote: { enabled: true } }))
    await updateRemoteSettings(file, { notificationDetails: true, transcripts: false })
    const next = await updateRemoteSettings(file, { commandTtl: { costly: 1800, default: 3600 } })
    expect(next).toEqual({ enabled: true, notificationDetails: true, transcripts: false, commandTtl: { costly: 1800, default: 3600 } })
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw).toEqual({
      defaultAgent: 'codex',
      currentWorkspace: '/w',
      remote: { enabled: true, notificationDetails: true, transcripts: false, costlyTtlSeconds: 1800, defaultTtlSeconds: 3600 }
    })
    expect(await readRemoteSettings(file)).toEqual(next)
  })

  it('refuses TTLs out of range and reads a hand-edited bad value as the default', async () => {
    await expect(updateRemoteSettings(file, { commandTtl: { costly: 10, default: 3600 } })).rejects.toThrow(/between 60/)
    expect(remoteSettingsOf({ remote: { costlyTtlSeconds: -1, defaultTtlSeconds: 'x' as never } }).commandTtl).toEqual({ costly: 7200, default: 86400 })
  })
})
