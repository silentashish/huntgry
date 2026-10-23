import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkSignIn, createAccountState, createProbe, createSignInLifecycle } from './account-state'

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

describe('createSignInLifecycle (#146)', () => {
  const deferred = <T>() => {
    let resolve: (v: T) => void = () => undefined
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('a Connect during a Disconnect starts after its cleanup, and Disconnect never waits for it', async () => {
    const life = createSignInLifecycle<string>()
    const log: string[] = []
    // A sign-in window is open.
    const firstWindow = deferred<string>()
    const first = life.connect(() => firstWindow.promise)
    // Disconnect starts; its cleanup is held (the loader queue is busy).
    const cleanup = deferred<void>()
    let cancelledSeen: Promise<string> | null = null
    const disconnect = life.disconnect(async (cancelled) => {
      cancelledSeen = cancelled
      log.push('disconnect: start')
      await cleanup.promise
      await cancelled
      log.push('disconnect: done')
      return 'disconnected'
    })
    expect(life.disconnecting).toBe(true)
    expect(cancelledSeen).toBe(first)
    // The user remounts Settings and clicks Connect again during the cleanup: it does not start yet,
    // and it does not join the sign-in being cancelled.
    const secondWindow = deferred<string>()
    let secondStarted = false
    const second = life.connect(() => {
      secondStarted = true
      log.push('connect 2: start')
      return secondWindow.promise
    })
    expect(second).not.toBe(first)
    await Promise.resolve()
    expect(secondStarted).toBe(false)
    // Check waits for the cleanup too.
    let checked = false
    const check = life.settled().then(() => (checked = true))

    // The cancelled window closes, then the cleanup finishes: Disconnect is done without waiting for Connect 2.
    firstWindow.resolve('closed')
    cleanup.resolve()
    expect(await disconnect).toBe('disconnected')
    await check
    expect(checked).toBe(true)
    expect(life.disconnecting).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual(['disconnect: start', 'disconnect: done', 'connect 2: start'])
    // Connect 2 signs in afterwards and keeps its result.
    secondWindow.resolve('connected')
    expect(await second).toBe('connected')
  })

  it('shares a running Connect, and a second Disconnect joins the first', async () => {
    const life = createSignInLifecycle<string>()
    const win = deferred<string>()
    const a = life.connect(() => win.promise)
    expect(life.connect(async () => 'other')).toBe(a)
    const hold = deferred<string>()
    const d1 = life.disconnect(() => hold.promise)
    expect(life.disconnect(async () => 'other')).toBe(d1)
    win.resolve('closed')
    hold.resolve('done')
    expect(await d1).toBe('done')
    // A new Connect after everything settled runs on its own.
    expect(await life.connect(async () => 'fresh')).toBe('fresh')
  })
})

describe('checkSignIn (#146)', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huntgry-jobright-check-'))
    file = join(dir, 'settings.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const deferred = <T>() => {
    let resolve: (v: T) => void = () => undefined
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('a Disconnect while the check picks a posting is never undone: the check starts over after it', async () => {
    const state = createAccountState(() => file, () => NOW)
    const life = createSignInLifecycle<unknown>()
    await state.record(true, state.generation())
    // The session cookie, as the loader would send it.
    let cookie = true
    const picking = deferred<string>()
    let picks = 0
    const loads: boolean[] = []
    const check = checkSignIn({
      lifecycle: life,
      state,
      pick: () => (++picks === 1 ? picking.promise : Promise.resolve('https://jobright.ai/jobs/info/abc123')),
      load: async () => {
        loads.push(cookie)
        return { ok: true, logined: cookie }
      }
    })
    // Disconnect starts while the posting is being picked; its cookie removal is still running.
    const removal = deferred<void>()
    const disconnect = life.disconnect(async () => {
      await state.reset()
      await removal.promise
      cookie = false
      return null
    })
    // Picking finishes before the cookies are gone: the check must not load now.
    picking.resolve('https://jobright.ai/jobs/info/abc123')
    await new Promise((r) => setTimeout(r, 0))
    expect(loads).toEqual([])
    removal.resolve()
    await disconnect
    // It started over after the cleanup and saw the signed-out page.
    expect(await check).toBe(false)
    expect(loads).toEqual([false])
    expect(picks).toBe(2)
    expect((await state.read()).connected).toBe(false)
  })

  it('a Disconnect after the load was queued drops the signed-in result', async () => {
    const state = createAccountState(() => file, () => NOW)
    const life = createSignInLifecycle<unknown>()
    const page = deferred<{ ok: true; logined: boolean }>()
    const check = checkSignIn({ lifecycle: life, state, pick: async () => 'https://jobright.ai/jobs/info/abc123', load: () => page.promise })
    await new Promise((r) => setTimeout(r, 0))
    await life.disconnect(async () => {
      await state.reset()
      return null
    })
    page.resolve({ ok: true, logined: true })
    expect(await check).toBe(true)
    expect((await state.read()).connected).toBe(false)
  })

  it('says why when the page did not load or did not say', async () => {
    const state = createAccountState(() => file, () => NOW)
    const life = createSignInLifecycle<unknown>()
    const pick = async () => 'https://jobright.ai/jobs/info/abc123'
    await expect(checkSignIn({ lifecycle: life, state, pick, load: async () => ({ ok: false, message: 'offline' }) })).rejects.toThrow(
      'Could not check the Jobright sign-in: offline'
    )
    await expect(checkSignIn({ lifecycle: life, state, pick, load: async () => ({ ok: true, logined: null }) })).rejects.toThrow(
      /did not say whether you are signed in/
    )
  })
})
