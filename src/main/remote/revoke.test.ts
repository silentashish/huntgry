import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueueState } from '@shared/queue-types'
import { DeviceStore } from './devices'
import { Gateway, type GatewayServices } from './gateway'
import { revokeDevice } from './revoke'
import { command, fakeCipher, fakePhone, queueState, type FakePhone } from './test-helpers'
import { workspaceIdentity, type WorkspaceIdentity } from './workspace'

let dir: string
let ws: string
let devices: DeviceStore
let phone: FakePhone
let identity: WorkspaceIdentity
let paused: boolean

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-revoke-'))
  ws = await mkdtemp(join(tmpdir(), 'huntgry-revoke-ws-'))
  identity = await workspaceIdentity(ws)
  devices = new DeviceStore(dir, fakeCipher())
  await devices.load()
  phone = fakePhone((await devices.keyPair())!)
  await devices.add(phone.record)
  paused = false
})
afterEach(async () => {
  await devices.flush()
  await rm(dir, { recursive: true, force: true })
  await rm(ws, { recursive: true, force: true })
})

function gateway(): Gateway {
  const q = (): QueueState => queueState({ paused })
  const services = {
    desktopName: 'Mac',
    appVersion: '0.1.0',
    workspace: async () => identity,
    agents: async () => [],
    defaultAgent: async () => 'claude',
    queue: {
      state: async () => q(),
      setPaused: async (_w: string, p: boolean) => {
        paused = p
        return q()
      }
    },
    transcripts: () => true
  } as unknown as GatewayServices
  return new Gateway(services, devices)
}

describe('revokeDevice', () => {
  it('removes the phone on this Mac before the relay answers, so a stalled DELETE never keeps it authorised', async () => {
    const g = gateway()
    const stale = devices.get(phone.id)!
    let deleteCalled = false
    let aborted = false
    const revoking = revokeDevice(
      {
        devices,
        notify: async () => undefined,
        relayDelete: (_id, signal) =>
          new Promise<void>(() => {
            deleteCalled = true
            signal.addEventListener('abort', () => (aborted = true))
          }),
        timeoutMs: 100
      },
      phone.id,
      'Removed in Settings.'
    )
    for (let i = 0; i < 200 && !deleteCalled; i++) await new Promise((r) => setTimeout(r, 5))
    expect(deleteCalled).toBe(true)
    expect(devices.get(phone.id)).toBeNull()
    // The relay has not answered, yet a command already queued for this phone is denied.
    const reply = await g.handle(stale, command(phone, 'queue.setPaused', { paused: true }, identity.id))
    expect(reply.result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(paused).toBe(false)
    // The relay call is bounded: it is aborted and the outcome says the relay did not confirm.
    await expect(revoking).resolves.toEqual({ removed: true, relayRevoked: false })
    expect(aborted).toBe(true)
  })

  it('tells the phone with the captured record and reports a confirmed relay deletion', async () => {
    const notified: string[] = []
    const outcome = await revokeDevice(
      {
        devices,
        notify: async (record, reason) => {
          notified.push(`${record.id}:${reason}`)
        },
        relayDelete: async () => undefined
      },
      phone.id,
      'Bye.'
    )
    expect(outcome).toEqual({ removed: true, relayRevoked: true })
    expect(notified).toEqual([`${phone.id}:Bye.`])
    expect(await revokeDevice({ devices, notify: async () => undefined, relayDelete: async () => undefined }, phone.id, 'again')).toEqual({ removed: false, relayRevoked: false })
  })
})
