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
