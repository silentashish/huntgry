import { describe, expect, it } from 'vitest'
import { settle } from '../remote/test-helpers'
import type { AndroidChannel } from './categories'
import { describePush, isExpoPushToken, PushRegistrar, type Permission, type PushPort, type PushRegistrarOptions, type PushSinkValue } from './push'

const TOKEN = 'ExponentPushToken[abc-DEF_123]'

class FakePort implements PushPort {
  permission: Permission = { status: 'undetermined', canAskAgain: true }
  /** What the system prompt answers. */
  answer: Permission = { status: 'granted', canAskAgain: true }
  token: string | Error = TOKEN
  prompts = 0
  tokenCalls: string[] = []
  channels: AndroidChannel[][] = []
  private tokenListener: (() => void) | null = null

  async setupChannels(channels: readonly AndroidChannel[]) {
    this.channels.push([...channels])
  }
  async getPermission() {
    return this.permission
  }
  async requestPermission() {
    this.prompts++
    if (this.permission.canAskAgain) this.permission = this.answer
    return this.permission
  }
  async getExpoPushToken(projectId: string) {
    this.tokenCalls.push(projectId)
    if (this.token instanceof Error) throw this.token
    return this.token
  }
  onTokenChange(listener: () => void) {
    this.tokenListener = listener
    return () => void (this.tokenListener = null)
  }
  rotate(token: string) {
    this.token = token
    this.tokenListener?.()
  }
}

function setup(over: Partial<PushRegistrarOptions> = {}, stored: boolean | null = null) {
  const port = new FakePort()
  let choice = stored
  const sunk: PushSinkValue[] = []
  const registrar = new PushRegistrar({
    port,
    prefs: { load: async () => choice, save: async (on) => void (choice = on) },
    sink: (v) => void sunk.push(v),
    projectId: 'project-1',
    isDevice: true,
    platform: 'ios',
    ...over
  })
  return { port, registrar, sunk, choice: () => choice }
}

describe('push registration', () => {
  it('never prompts on launch: a phone that was never asked stays silent and sends nothing', async () => {
    const t = setup()
    await t.registrar.start()
    expect(t.port.prompts).toBe(0)
    expect(t.sunk).toEqual([])
    expect(t.registrar.getSnapshot()).toMatchObject({ enabled: null, token: null })
  })

  it('asks right after pairing, then registers the Expo token with the relay', async () => {
    const t = setup()
    await t.registrar.start()
    await t.registrar.onPaired()
    expect(t.port.prompts).toBe(1)
    expect(t.port.tokenCalls).toEqual(['project-1'])
    expect(t.sunk).toEqual([TOKEN])
    expect(t.choice()).toBe(true)
    expect(t.registrar.getSnapshot()).toMatchObject({ enabled: true, permission: 'granted', token: TOKEN, busy: false })
  })

  it('asks only once: a later pairing or launch with a choice made does not prompt', async () => {
    const t = setup({}, false)
    await t.registrar.start()
    await t.registrar.onPaired()
    expect(t.port.prompts).toBe(0)
    expect(t.sunk).toEqual([null])
  })

  it('"Don\'t allow" removes the token at the relay and Settings offers the system Settings', async () => {
    const t = setup()
    t.port.answer = { status: 'denied', canAskAgain: false }
    await t.registrar.start()
    await t.registrar.onPaired()
    expect(t.sunk).toEqual([null])
    const s = t.registrar.getSnapshot()
    expect(s).toMatchObject({ enabled: true, permission: 'denied', canAskAgain: false, token: null })
    expect(describePush(s)).toMatchObject({ on: false, openSettings: true })
  })

  it('turning push off in Settings sends null; on again registers without a prompt when allowed', async () => {
    const t = setup({}, true)
    t.port.permission = { status: 'granted', canAskAgain: true }
    await t.registrar.start()
    await t.registrar.disable()
    expect(t.choice()).toBe(false)
    await t.registrar.enable()
    expect(t.port.prompts).toBe(0)
    expect(t.sunk).toEqual([TOKEN, null, TOKEN])
  })

  it('on launch with push on, registers the current token; a withdrawn permission removes it', async () => {
    const t = setup({}, true)
    t.port.permission = { status: 'granted', canAskAgain: true }
    await t.registrar.start()
    expect(t.sunk).toEqual([TOKEN])
    t.port.permission = { status: 'denied', canAskAgain: false }
    await t.registrar.refresh()
    expect(t.sunk).toEqual([TOKEN, null])
    t.port.permission = { status: 'granted', canAskAgain: true }
    await t.registrar.refresh()
    expect(t.sunk).toEqual([TOKEN, null, TOKEN])
  })

  it('re-sends when the token changes and stays quiet when it does not', async () => {
    const t = setup({}, true)
    t.port.permission = { status: 'granted', canAskAgain: true }
    await t.registrar.start()
    await t.registrar.refresh()
    expect(t.sunk).toEqual([TOKEN])
    t.port.rotate('ExponentPushToken[rotated]')
    await settle()
    expect(t.sunk).toEqual([TOKEN, 'ExponentPushToken[rotated]'])
  })

  it('a failed token fetch keeps what the relay has and is retried on the next foreground', async () => {
    const t = setup({}, true)
    t.port.permission = { status: 'granted', canAskAgain: true }
    t.port.token = new Error('Network request failed')
    await t.registrar.start()
    expect(t.sunk).toEqual([])
    expect(t.registrar.getSnapshot().error).toBe('Network request failed')
    expect(describePush(t.registrar.getSnapshot()).line).toContain('Network request failed')
    t.port.token = TOKEN
    await t.registrar.refresh()
    expect(t.sunk).toEqual([TOKEN])
    expect(t.registrar.getSnapshot().error).toBeNull()
  })

  it('never hands the relay a token its guard refuses', async () => {
    const t = setup({}, true)
    t.port.permission = { status: 'granted', canAskAgain: true }
    t.port.token = 'garbage'
    await t.registrar.start()
    expect(t.sunk).toEqual([])
    expect(isExpoPushToken(TOKEN)).toBe(true)
    expect(isExpoPushToken('ExpoPushToken[x]')).toBe(true)
    expect(isExpoPushToken('garbage')).toBe(false)
    expect(isExpoPushToken(null)).toBe(false)
  })

  it('is unavailable without an EAS project id, on a simulator and on the web, and never prompts there', async () => {
    for (const over of [{ projectId: null }, { isDevice: false }, { platform: 'web' }]) {
      const t = setup(over)
      await t.registrar.start()
      await t.registrar.onPaired()
      expect(t.port.prompts).toBe(0)
      expect(t.port.tokenCalls).toEqual([])
      const summary = describePush(t.registrar.getSnapshot())
      expect(summary).toMatchObject({ on: false, canToggle: false })
    }
    expect(describePush(setup({ projectId: null }).registrar.getSnapshot()).line).toContain('EAS project id')
  })

  it('creates the per-category channels on Android before asking', async () => {
    const t = setup({ platform: 'android' })
    await t.registrar.start()
    expect(t.port.channels).toHaveLength(1)
    expect(t.port.channels[0].map((c) => c.id)).toEqual(['needs-reply', 'usage-limit', 'pipeline-finished', 'needs-review', 'failed'])
    expect(setup().port.channels).toEqual([])
  })

  it('reset after unpair forgets the choice, so the next pairing asks again', async () => {
    const t = setup()
    await t.registrar.start()
    await t.registrar.onPaired()
    t.registrar.reset()
    expect(t.registrar.getSnapshot()).toMatchObject({ enabled: null, token: null })
    // The model already sent null on unpair; the same token is handed over again after the next pairing.
    await t.registrar.onPaired()
    expect(t.sunk).toEqual([TOKEN, TOKEN])
  })

  it('drops a token that Expo returns after the phone unpaired', async () => {
    const t = setup()
    let release: (token: string) => void = () => undefined
    t.port.getExpoPushToken = (projectId: string) => {
      t.port.tokenCalls.push(projectId)
      return new Promise<string>((r) => (release = r))
    }
    await t.registrar.start()
    const pairing = t.registrar.onPaired()
    await settle()
    expect(t.port.tokenCalls).toHaveLength(1) // waiting on Expo
    t.registrar.reset() // the owner unpaired meanwhile
    release(TOKEN)
    await pairing
    expect(t.sunk).toEqual([])
    expect(t.registrar.getSnapshot()).toMatchObject({ enabled: null, token: null, busy: false })
  })

  it('serialises a toggle that arrives during a foreground refresh', async () => {
    const t = setup({}, true)
    t.port.permission = { status: 'granted', canAskAgain: true }
    await t.registrar.start()
    const a = t.registrar.refresh()
    const b = t.registrar.disable()
    await Promise.all([a, b])
    expect(t.sunk.at(-1)).toBeNull()
    expect(t.registrar.getSnapshot().enabled).toBe(false)
  })
})

describe('what Settings says', () => {
  it('describes each state', () => {
    const base = setup().registrar.getSnapshot()
    expect(describePush({ ...base, enabled: null })).toMatchObject({ on: false, canToggle: true })
    expect(describePush({ ...base, enabled: true, permission: 'granted', token: TOKEN }).line).toBe('On. Pushes arrive while the app is closed.')
    expect(describePush({ ...base, enabled: true, permission: 'denied', canAskAgain: true })).toMatchObject({ on: false, openSettings: false })
    expect(describePush({ ...base, enabled: true, busy: true, permission: 'unknown' }).line).toBe('Turning on…')
  })
})
