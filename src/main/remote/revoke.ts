import type { DeviceRecord, DeviceStore } from './devices'

/**
 * Revoking a phone (ADR-0001, "Revocation and audit") is a security boundary on the Mac, so it
 * must hold during a relay outage: the device record (and with it the session key) is removed
 * locally **first**, which makes the gateway deny every frame of that device still queued or
 * yet to come. Telling the phone and deleting its relay token follow as bounded best effort.
 */

export interface RevokeDeps {
  devices: Pick<DeviceStore, 'get' | 'remove'>
  /** Sends `device.revoked` boxed for this record (the store no longer has it). */
  notify(device: DeviceRecord, reason: string): Promise<void>
  /** `DELETE` of the device's relay token; `signal` aborts it at the deadline. */
  relayDelete(deviceId: string, signal: AbortSignal): Promise<void>
  /** Per remote step; default 10 s. */
  timeoutMs?: number
}

export interface RevokeOutcome {
  /** The device was paired and is now removed on this Mac. */
  removed: boolean
  /** The relay confirmed the token deletion (false: failed or timed out; the phone is still refused here). */
  relayRevoked: boolean
}

function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${ms} ms`))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([work(controller.signal), deadline]).finally(() => clearTimeout(timer))
}

export async function revokeDevice(deps: RevokeDeps, id: string, reason: string): Promise<RevokeOutcome> {
  const record = deps.devices.get(id)
  if (!record) return { removed: false, relayRevoked: false }
  await deps.devices.remove(id)
  const ms = deps.timeoutMs ?? 10_000
  const [, relay] = await Promise.allSettled([bounded(() => deps.notify(record, reason), ms), bounded((signal) => deps.relayDelete(id, signal), ms)])
  if (relay.status === 'rejected') console.warn(`[remote] revoking ${id} on the relay failed:`, (relay.reason as Error)?.message ?? relay.reason)
  return { removed: true, relayRevoked: relay.status === 'fulfilled' }
}
