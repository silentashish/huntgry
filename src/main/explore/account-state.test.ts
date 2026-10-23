import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountState, createProbe } from './account-state'

const NOW = new Date('2026-10-22T12:00:00.000Z')

describe('Jobright account state (#146)', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huntgry-jobright-account-'))
    file = join(dir, 'settings.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores what a page said, with the time, next to the other app settings', async () => {
    const state = createAccountState(() => file, () => NOW)
    expect(await state.read()).toEqual({ connected: null, checkedAt: null })
    expect(await state.record(true, state.generation())).toBe(true)
    expect(await state.read()).toEqual({ connected: true, checkedAt: NOW.toISOString() })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ jobright: { connected: true, checkedAt: NOW.toISOString() } })
  })

  it('drops a signed-in result that started before a Disconnect', async () => {
    const state = createAccountState(() => file, () => NOW)
    await state.record(true, state.generation())
    // A signed-in page starts loading, then the user disconnects before it reports.
    const before = state.generation()
    await state.reset()
    expect(await state.record(true, before)).toBe(false)
    expect((await state.read()).connected).toBe(false)
    // A probe started after the Disconnect counts.
    expect(await state.record(true, state.generation())).toBe(true)
    expect((await state.read()).connected).toBe(true)
  })

  it('serializes writes: concurrent reports never interleave their read-modify-write', async () => {
    const state = createAccountState(() => file, () => NOW)
    const gen = state.generation()
    await Promise.all([state.record(true, gen), state.record(false, gen), state.record(true, gen)])
    expect((await state.read()).connected).toBe(true)
    const writes = [state.record(false, gen), state.reset(), state.record(true, gen)]
    await Promise.all(writes)
    // The last write was from the old generation: dropped, so the reset's `false` stands.
    expect((await state.read()).connected).toBe(false)
  })
})

describe('createProbe (#146)', () => {
  it('runs a request made during a check once more after it, instead of dropping it', async () => {
    let calls = 0
    let release: () => void = () => undefined
    let signedIn = false
    const probe = createProbe(async () => {
      calls += 1
      // Like a page load: what it reports is the state when it was requested.
      const seen = signedIn
      if (calls === 1) await new Promise<void>((r) => (release = r))
      return seen
    })
    const first = probe.request()
    // The sign-in finishes while the first (signed-out) check is still loading; two navigations arrive.
    signedIn = true
    void probe.request()
    void probe.request()
    release()
    await first
    expect(calls).toBe(2)
    // Done: later requests do nothing.
    await probe.request()
    expect(calls).toBe(2)
  })

  it('keeps going after a failed check, and stop() ends it', async () => {
    let calls = 0
    const probe = createProbe(async () => {
      calls += 1
      if (calls === 1) throw new Error('did not load')
      return false
    })
    await probe.request()
    await probe.request()
    expect(calls).toBe(2)
    probe.stop()
    await probe.request()
    expect(calls).toBe(2)
  })
})
