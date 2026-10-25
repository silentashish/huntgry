import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AUTOMATION_SETTINGS, normalizeAutomationSettings, requireSettingsPatch } from '@shared/automation-types'
import { readAutomationSettings, updateAutomationSettings } from './settings'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-automation-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('automation settings', () => {
  it('defaults: Match ≥ 80 with ≥ 4 requirements, 2 per company, 10 a day, $15 a run, 22:00–07:00, both sources', async () => {
    expect(await readAutomationSettings(file)).toEqual(DEFAULT_AUTOMATION_SETTINGS)
    expect(DEFAULT_AUTOMATION_SETTINGS).toMatchObject({
      threshold: 80,
      minRequirements: 4,
      perCompany: 2,
      perDay: 10,
      maxCostUsd: 15,
      window: { mode: 'window', start: '22:00', end: '07:00' },
      sources: { jobs: true, explore: true }
    })
  })

  it('clamps every number to its bounds and drops what it cannot read', () => {
    expect(
      normalizeAutomationSettings({ threshold: 20, minRequirements: 99, perCompany: 0, perDay: 500, maxCostUsd: 0.1, maxExplorePageLoads: -3 })
    ).toMatchObject({ threshold: 50, minRequirements: 20, perCompany: 1, perDay: 50, maxCostUsd: 0.5, maxExplorePageLoads: 0 })
    expect(normalizeAutomationSettings({ threshold: 'high', perDay: 7.6, maxCostUsd: 12.345 })).toMatchObject({ threshold: 80, perDay: 8, maxCostUsd: 12.35 })
    expect(normalizeAutomationSettings({ window: { mode: 'window', start: '25:00', end: '07:00' } }).window).toEqual(DEFAULT_AUTOMATION_SETTINGS.window)
    expect(normalizeAutomationSettings({ window: { mode: 'window', start: '08:00', end: '08:00' } }).window).toEqual(DEFAULT_AUTOMATION_SETTINGS.window)
    expect(normalizeAutomationSettings({ window: { mode: 'anytime' } }).window).toEqual({ mode: 'anytime' })
    expect(normalizeAutomationSettings('nonsense')).toEqual(DEFAULT_AUTOMATION_SETTINGS)
  })

  it('stores a patch in userData settings next to the other settings, clamped, sources merged', async () => {
    await writeFile(file, JSON.stringify({ currentWorkspace: '/w', defaultAgent: 'codex' }))
    const next = await updateAutomationSettings(file, { perDay: 99, sources: { explore: false }, window: { mode: 'anytime' } })
    expect(next).toMatchObject({ perDay: 50, sources: { jobs: true, explore: false }, window: { mode: 'anytime' } })
    const stored = JSON.parse(await readFile(file, 'utf8'))
    expect(stored.currentWorkspace).toBe('/w')
    expect(stored.defaultAgent).toBe('codex')
    expect(stored.automation.perDay).toBe(50)
    expect(await readAutomationSettings(file)).toEqual(next)
  })

  it('two quick changes both hold (writes go one after another)', async () => {
    await Promise.all([updateAutomationSettings(file, { perDay: 5 }), updateAutomationSettings(file, { perCompany: 3 })])
    expect(await readAutomationSettings(file)).toMatchObject({ perDay: 5, perCompany: 3 })
  })

  it('checks a patch from the renderer', () => {
    expect(requireSettingsPatch({ threshold: 85, sources: { jobs: false }, extra: 1 })).toEqual({ threshold: 85, sources: { jobs: false } })
    expect(() => requireSettingsPatch({ threshold: '85' })).toThrow('Invalid threshold.')
    expect(() => requireSettingsPatch({ window: { mode: 'window', start: '22:00' } })).toThrow(/start and an end/)
    expect(() => requireSettingsPatch({ sources: { explore: 'yes' } })).toThrow(/source explore/)
    expect(() => requireSettingsPatch(null)).toThrow()
  })
})
