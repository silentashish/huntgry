/**
 * expo-notifications behind the `PushPort` the registrar uses, plus the two things only the
 * native module can do: decide what a push does while the app is open, and report taps. Kept
 * thin on purpose; the rules live in `push.ts`, `taps.ts` and `categories.ts` (unit-tested).
 */

import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { categoryOf, GENERIC_BODY } from './categories'
import type { Permission, PushPort, PushRegistrarOptions } from './push'
import type { NotificationCategory } from '@huntgry/remote-protocol'

/** Native push exists on iOS and Android only; the web build (demo, screenshots) never loads it. */
export const NATIVE_PUSH = Platform.OS === 'ios' || Platform.OS === 'android'

function toPermission(p: Notifications.NotificationPermissionsStatus): Permission {
  const ios = p.ios?.status
  const granted = p.status === 'granted' || ios === Notifications.IosAuthorizationStatus.PROVISIONAL || ios === Notifications.IosAuthorizationStatus.EPHEMERAL
  return { status: granted ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined', canAskAgain: p.canAskAgain }
}

export const expoPushPort: PushPort = {
  async setupChannels(channels) {
    if (Platform.OS !== 'android') return
    for (const c of channels) {
      await Notifications.setNotificationChannelAsync(c.id, {
        name: c.name,
        description: c.description,
        importance: c.importance === 'high' ? Notifications.AndroidImportance.HIGH : Notifications.AndroidImportance.DEFAULT,
        lightColor: '#E66E0A',
        showBadge: false
      })
    }
  },
  getPermission: async () => toPermission(await Notifications.getPermissionsAsync()),
  // Alerts and sound; no badge (the app shows counts itself) and no provisional "quiet" delivery.
  requestPermission: async () => toPermission(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })),
  getExpoPushToken: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  onTokenChange(listener) {
    const sub = Notifications.addPushTokenListener(() => listener())
    return () => sub.remove()
  }
}

/** The EAS project id baked into the build (`app.config.ts` → `extra.eas.projectId`), if any. */
export function easProjectId(): string | null {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId
  const id = typeof fromConfig === 'string' && fromConfig ? fromConfig : Constants.easConfig?.projectId
  return typeof id === 'string' && id ? id : null
}

export function nativeRegistrarOptions(): Pick<PushRegistrarOptions, 'port' | 'projectId' | 'isDevice' | 'platform'> {
  return { port: expoPushPort, projectId: easProjectId(), isDevice: Device.isDevice, platform: Platform.OS }
}

export interface Incoming {
  /** Unique per delivered notification; dedupes a cold-start tap reported twice. */
  id: string
  category: NotificationCategory
  /** What the notification says: the generic body, or the desktop's `pushText` when details are on. */
  body: string
  data: unknown
}

function incoming(n: Notifications.Notification): Incoming | null {
  const data = n.request.content.data
  const category = categoryOf(data)
  if (!category) return null
  return { id: n.request.identifier, category, body: n.request.content.body || GENERIC_BODY[category], data }
}

/**
 * While the app is open the screens are live, so a push (the relay only pushes when this phone
 * had no socket) shows no banner, plays no sound and is not kept in the list: `onForeground`
 * shows it as an in-app toast and reconnects instead.
 */
export function listen(handlers: { onForeground(n: Incoming): void; onTap(n: Incoming): void }): () => void {
  if (!NATIVE_PUSH) return () => undefined
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const parsed = incoming(n)
      if (parsed) handlers.onForeground(parsed)
      return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }
    }
  })
  const onResponse = (r: Notifications.NotificationResponse) => {
    if (r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    const parsed = incoming(r.notification)
    if (parsed) handlers.onTap(parsed)
    // Handled: a reload of the JS bundle must not open the same screen again.
    Notifications.clearLastNotificationResponse()
  }
  const sub = Notifications.addNotificationResponseReceivedListener(onResponse)
  // Launched by a tap (the app was not running): the response is waiting already.
  const last = Notifications.getLastNotificationResponse()
  if (last) onResponse(last)
  return () => {
    sub.remove()
    Notifications.setNotificationHandler(null)
  }
}
