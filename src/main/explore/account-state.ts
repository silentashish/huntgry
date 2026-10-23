import type { JobrightAccount } from '@shared/explore-types'
import { loadSettings, saveSettings } from '../workspace/settings'
import { accountOf } from './employer-link'

/**
 * The Jobright sign-in as last seen (#146), stored with the app settings. Electron-free (the settings file is
 * a parameter) so the races below are unit-tested.
 *
 * - Writes are serialized: two pages reporting at once never interleave their read-modify-write.
 * - Every probe takes the current `generation` before it loads anything, and its result is dropped when the
 *   generation moved on since. Disconnect bumps it, so a signed-in page that was already loading cannot
 *   write "connected" back after the user disconnected.
 */
export interface AccountState {
  read(): Promise<JobrightAccount>
  /** The generation a probe starting now belongs to. */
  generation(): number
  /** Stores a page's `logined`, unless `generation` is stale; returns whether it was stored. */
  record(logined: boolean, generation: number): Promise<boolean>
  /** Starts a new generation (stale probes are dropped) and stores `connected: false`. */
  reset(): Promise<void>
}

export function createAccountState(file: () => string, now: () => Date = () => new Date()): AccountState {
  let generation = 0
  let writes: Promise<unknown> = Promise.resolve()
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = writes.then(job)
    writes = run.catch(() => undefined)
    return run
  }
  const write = (connected: boolean) =>
    saveSettings(file(), { jobright: { connected, checkedAt: now().toISOString() } })
  return {
    read: async () => {
      await writes
      return accountOf(await loadSettings(file()))
    },
    generation: () => generation,
    record: (logined, gen) =>
      serial(async () => {
        if (gen !== generation) return false
        await write(logined)
        return true
      }),
    reset: () => {
      generation += 1
      return serial(() => write(false))
    }
  }
}

/**
 * Coalesces check requests while one runs: a request during a check is not dropped but runs once more right
 * after it, so a sign-in that completes mid-check is still seen. `check` returns `true` to stop for good.
 */
export function createProbe(check: () => Promise<boolean>): { request(): Promise<void>; stop(): void } {
  let running: Promise<void> | null = null
  let again = false
  let done = false
  const loop = async () => {
    do {
      again = false
      if (done) return
      try {
        if (await check()) done = true
      } catch {
        // A failed check (page did not load) is retried on the next request.
      }
    } while (again && !done)
  }
  return {
    request() {
      if (done) return Promise.resolve()
      if (running) {
        again = true
        return running
      }
      running = loop().finally(() => {
        running = null
      })
      return running
    },
    stop() {
      done = true
    }
  }
}

/**
 * Who may run when (#146): one Connect at a time, one Disconnect at a time, and Disconnect exclusive.
 * A Connect asked for during a Disconnect starts after its cleanup (in the new generation), never joins
 * the sign-in being cancelled; Disconnect is handed only the Connect it cancels, never one started later.
 */
export interface SignInLifecycle<T> {
  /** Whether a Disconnect is cleaning up. */
  readonly disconnecting: boolean
  /** Runs `run` unless a Connect is already running (then that one's result); after any Disconnect in progress. */
  connect(run: () => Promise<T>): Promise<T>
  /** Resolves once no Disconnect is in progress (Check waits for it). */
  settled(): Promise<void>
  /** Runs `run` with the Connect it cancels (or `null`); a second Disconnect meanwhile shares the first. */
  disconnect(run: (cancelled: Promise<T> | null) => Promise<T>): Promise<T>
}

export function createSignInLifecycle<T>(): SignInLifecycle<T> {
  let connecting: Promise<T> | null = null
  let disconnecting: Promise<T> | null = null
  const lifecycle: SignInLifecycle<T> = {
    get disconnecting() {
      return disconnecting !== null
    },
    connect(run) {
      if (disconnecting) return disconnecting.catch(() => undefined).then(() => lifecycle.connect(run))
      if (connecting) return connecting
      const started: Promise<T> = run().finally(() => {
        if (connecting === started) connecting = null
      })
      connecting = started
      return started
    },
    settled: async () => {
      while (disconnecting) await disconnecting.catch(() => undefined)
    },
    disconnect(run) {
      if (disconnecting) return disconnecting
      const started: Promise<T> = run(connecting).finally(() => {
        if (disconnecting === started) disconnecting = null
      })
      disconnecting = started
      return started
    }
  }
  return lifecycle
}

export type CheckLoad = { ok: true; logined: boolean | null } | { ok: false; message: string }

/**
 * Check sign-in (#146) without letting a Disconnect be undone. The generation is taken before the first await;
 * picking a posting may take a while (it can fetch the Explore list), so right before the load is queued, with
 * no await in between, the check makes sure no Disconnect started meanwhile, and starts over after it if one
 * did. A Disconnect that starts once the load is queued bumps the generation, so the result is dropped.
 * Returns the page's `logined`; throws when the page did not load or say.
 */
export async function checkSignIn(deps: {
  lifecycle: Pick<SignInLifecycle<unknown>, 'disconnecting' | 'settled'>
  state: Pick<AccountState, 'generation' | 'record'>
  pick(): Promise<string>
  /** Queues the page load synchronously (the hidden loader does), then resolves with what it said. */
  load(url: string): Promise<CheckLoad>
}): Promise<boolean> {
  for (;;) {
    await deps.lifecycle.settled()
    const generation = deps.state.generation()
    const url = await deps.pick()
    if (deps.lifecycle.disconnecting || deps.state.generation() !== generation) continue
    const res = await deps.load(url)
    if (!res.ok) throw new Error(`Could not check the Jobright sign-in: ${res.message}`)
    if (res.logined === null) throw new Error('The Jobright page did not say whether you are signed in. Try again later.')
    await deps.state.record(res.logined, generation)
    return res.logined
  }
}
