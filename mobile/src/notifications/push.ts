/**
 * Push registration on the phone (#39): the permission, the Expo push token and what the relay
 * is told. Plain TypeScript around a small `PushPort` (expo-notifications on the phone, a fake in
 * the tests), so every rule here is unit-tested in Node.
 *
 * - **When to ask.** Never on first launch: right after a pairing succeeds (the owner just
 *   connected the phone, so the question makes sense), or when they turn push on in Settings.
 *   A phone paired before this version is asked from Settings only.
 * - **What the relay gets.** The Expo push token, through the model's clear `{ pushToken }`
 *   frame after authentication; `null` when the owner turns push off, the system permission is
 *   withdrawn, or the phone unpairs (the model's `farewell`). The token never reaches the Mac.
 * - **Changes.** The token is fetched again when the app comes back to the foreground and when
 *   the OS reports a new device token; the relay is told only what changed.
 */

import { requireRelayClientFrame } from '@huntgry/remote-protocol'
import { ANDROID_CHANNELS, type AndroidChannel } from './categories'

export type PermissionStatus = 'granted' | 'denied' | 'undetermined'

export interface Permission {
  status: PermissionStatus
  /** iOS asks once; after a "Don't allow" only the system Settings app can change it. */
  canAskAgain: boolean
}

/** What the registrar needs from expo-notifications. */
export interface PushPort {
  /** Android: the per-category channels (must exist before Android 13 asks for permission). No-op elsewhere. */
  setupChannels(channels: readonly AndroidChannel[]): Promise<void>
  getPermission(): Promise<Permission>
  /** Shows the system prompt when it may still be shown. */
  requestPermission(): Promise<Permission>
  getExpoPushToken(projectId: string): Promise<string>
  /** The APNs / FCM device token changed; the Expo token must be fetched again. */
  onTokenChange(listener: () => void): () => void
}

/** The owner's choice, stored with the pairing (wiped on unpair). `null`: never asked. */
export interface PushPrefs {
  load(): Promise<boolean | null>
  save(enabled: boolean): Promise<void>
}

/** `undefined` = no opinion (nothing sent), `null` = remove, a string = register. */
export type PushSinkValue = string | null | undefined

export interface PushState {
  /** False when this build cannot receive push (no EAS project id, a simulator, the web). */
  available: boolean
  /** Why push is not available, for Settings. */
  unavailableReason: string | null
  /** The owner's choice in this app; `null` until asked. */
  enabled: boolean | null
  permission: PermissionStatus | 'unknown'
  canAskAgain: boolean
  /** The registered Expo push token (shown nowhere; tests and debugging). */
  token: string | null
  /** The last failure to get a token (offline, Expo down). Retried on the next foreground. */
  error: string | null
  busy: boolean
}

export interface PushRegistrarOptions {
  port: PushPort
  prefs: PushPrefs
  /** Where the token goes: `RemoteModel.setPushToken`. */
  sink(token: PushSinkValue): void
  /** The EAS project id (`extra.eas.projectId`); without it Expo issues no token. */
  projectId: string | null
  /** A physical device (simulators and the web get no push token). */
  isDevice: boolean
  platform: 'ios' | 'android' | 'web' | string
}

export const INITIAL_PUSH_STATE: PushState = {
  available: true,
  unavailableReason: null,
  enabled: null,
  permission: 'unknown',
  canAskAgain: true,
  token: null,
  error: null,
  busy: false
}

export class PushRegistrar {
  private state: PushState = INITIAL_PUSH_STATE
  private readonly listeners = new Set<() => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private unsubscribeToken: (() => void) | null = null
  private sent: PushSinkValue = undefined

  constructor(private readonly o: PushRegistrarOptions) {
    const reason = unavailableReason(o)
    if (reason) this.state = { ...this.state, available: false, unavailableReason: reason }
  }

  // ── store ────────────────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): PushState => this.state

  private set(patch: Partial<PushState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  /** Operations run one at a time: a toggle during a foreground refresh must not interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────

  /** App start with a pairing: channels, the stored choice, the permission (never a prompt). */
  start(): Promise<void> {
    return this.serial(async () => {
      if (!this.unsubscribeToken) this.unsubscribeToken = this.o.port.onTokenChange(() => void this.refresh())
      if (this.o.platform === 'android') await this.o.port.setupChannels(ANDROID_CHANNELS).catch(() => undefined)
      const enabled = await this.o.prefs.load().catch(() => null)
      this.set({ enabled })
      await this.sync(false)
    })
  }

  /** Right after a pairing succeeded: the moment to ask, once. */
  onPaired(): Promise<void> {
    return this.serial(async () => {
      if (this.state.enabled === null) await this.turnOn()
      else await this.sync(false)
    })
  }

  /** Settings → Push notifications on. Resolves with the new state (denied, no token, …). */
  enable(): Promise<PushState> {
    return this.serial(async () => {
      await this.turnOn()
      return this.state
    })
  }

  /** Settings → Push notifications off: the relay forgets the token. */
  disable(): Promise<void> {
    return this.serial(async () => {
      await this.o.prefs.save(false).catch(() => undefined)
      this.set({ enabled: false, token: null, error: null })
      this.emit(null)
    })
  }

  /** The app came back to the foreground (the owner may have changed the permission in Settings). */
  refresh(): Promise<void> {
    return this.serial(() => this.sync(false))
  }

  /** The phone unpaired (the model already told the relay): back to "never asked". */
  reset(): void {
    this.sent = undefined
    this.set({ ...INITIAL_PUSH_STATE, available: this.state.available, unavailableReason: this.state.unavailableReason })
  }

  /** Stops listening for token changes (`start` listens again). */
  dispose(): void {
    this.unsubscribeToken?.()
    this.unsubscribeToken = null
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  private async turnOn(): Promise<void> {
    await this.o.prefs.save(true).catch(() => undefined)
    this.set({ enabled: true })
    if (this.o.platform === 'android') await this.o.port.setupChannels(ANDROID_CHANNELS).catch(() => undefined)
    await this.sync(true)
  }

  /** Reads (or, with `ask`, requests) the permission and registers or removes the token to match. */
  private async sync(ask: boolean): Promise<void> {
    if (!this.state.available) {
      // Nothing to register; an earlier build's token (if any) is not ours to keep.
      if (this.state.enabled === false) this.emit(null)
      return
    }
    if (this.state.enabled !== true) {
      if (this.state.enabled === false) this.emit(null)
      return
    }
    this.set({ busy: true })
    try {
      let permission = await this.o.port.getPermission()
      if (ask && permission.status !== 'granted' && permission.canAskAgain) permission = await this.o.port.requestPermission()
      this.set({ permission: permission.status, canAskAgain: permission.canAskAgain })
      if (permission.status !== 'granted') {
        this.set({ token: null })
        this.emit(null)
        return
      }
      let token: string
      try {
        token = await this.o.port.getExpoPushToken(this.o.projectId!)
      } catch (err) {
        // Offline or Expo unreachable: the relay keeps whatever it had; tried again on the next foreground.
        this.set({ error: (err as Error)?.message || 'Could not get a push token.' })
        return
      }
      if (!isExpoPushToken(token)) {
        this.set({ error: 'Expo returned a push token the relay would refuse.' })
        return
      }
      this.set({ token, error: null })
      this.emit(token)
    } catch (err) {
      this.set({ error: (err as Error)?.message || 'Push notifications are not available.' })
    } finally {
      this.set({ busy: false })
    }
  }

  private emit(value: PushSinkValue): void {
    if (value === this.sent) return
    this.sent = value
    this.o.sink(value)
  }
}

function unavailableReason(o: Pick<PushRegistrarOptions, 'projectId' | 'isDevice' | 'platform'>): string | null {
  if (o.platform !== 'ios' && o.platform !== 'android') return 'Push notifications need the iPhone or Android app.'
  if (!o.isDevice) return 'Push notifications need a physical phone, not a simulator.'
  if (!o.projectId) return 'This build has no EAS project id, so Expo cannot deliver push (see mobile/RELEASE.md).'
  return null
}

/** The relay closes the socket for a token its guard refuses; the protocol package's guard decides. */
export function isExpoPushToken(token: unknown): token is string {
  try {
    requireRelayClientFrame({ pushToken: token })
    return typeof token === 'string'
  } catch {
    return false
  }
}

export interface PushSummary {
  /** The Settings switch. */
  on: boolean
  /** The switch can do something (push exists in this build). */
  canToggle: boolean
  line: string
  /** iOS will not ask again: only the system Settings app can allow notifications now. */
  openSettings: boolean
}

/** What Settings says about push, from the registrar's state. */
export function describePush(s: PushState): PushSummary {
  if (!s.available) return { on: false, canToggle: false, line: s.unavailableReason ?? 'Push notifications are not available.', openSettings: false }
  if (s.enabled !== true) return { on: false, canToggle: true, line: 'Off. Turn on to hear when a run needs you while the app is closed.', openSettings: false }
  if (s.permission === 'denied' || (s.permission === 'undetermined' && !s.canAskAgain)) {
    return { on: false, canToggle: true, line: 'Notifications are turned off for Huntgry in the system Settings.', openSettings: !s.canAskAgain }
  }
  if (s.token) return { on: true, canToggle: true, line: 'On. Pushes arrive while the app is closed.', openSettings: false }
  if (s.busy || s.permission === 'unknown') return { on: true, canToggle: true, line: 'Turning on…', openSettings: false }
  if (s.permission === 'undetermined') return { on: false, canToggle: true, line: 'Not allowed yet. Turn on to be asked.', openSettings: false }
  return { on: true, canToggle: true, line: `On, but the phone has no push token yet${s.error ? ` (${s.error})` : ''}. It tries again when you open the app.`, openSettings: false }
}
