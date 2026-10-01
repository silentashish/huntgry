/**
 * Expo push client (ADR-0001, "How a push happens"). The relay never knows what happened on
 * the Mac; it sends one generic body per category, `data: { category }` so the app knows what
 * to fetch, and `pushText` verbatim only when the owner opted into details.
 */
import type { NotificationCategory } from '@huntgry/remote-protocol'

export const PUSH_TITLE = 'Huntgry'

/** The fixed body per category; nothing else is ever sent to Expo. */
export const PUSH_BODIES: Record<NotificationCategory, string> = {
  'needs-reply': 'A run needs your reply',
  'usage-limit': 'Paused: usage limit',
  'pipeline-finished': 'Pipeline finished',
  'needs-review': 'Results need your review',
  failed: 'Something failed'
}

/** The registration guard accepts both spellings Expo has used. */
export const EXPO_PUSH_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,128}\]$/

export type PushOutcome = 'ok' | 'DeviceNotRegistered' | 'failed'

export interface PushMessage {
  to: string
  title: string
  body: string
  data: { category: NotificationCategory }
  sound: 'default'
  priority: 'high'
}

export function pushMessage(token: string, category: NotificationCategory, text?: string): PushMessage {
  return { to: token, title: PUSH_TITLE, body: text ?? PUSH_BODIES[category], data: { category }, sound: 'default', priority: 'high' }
}

/**
 * Sends one push and reports the ticket. Expo answers `{ data: [{ status, details }] }` for
 * an array request; `DeviceNotRegistered` means the token is dead and must be deleted.
 * Any other failure is `failed`: the relay does not retry (the phone fetches state when opened).
 */
export async function sendExpoPush(url: string, message: PushMessage): Promise<PushOutcome> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify([message])
    })
    if (!res.ok) return 'failed'
    const json = (await res.json()) as { data?: unknown }
    const tickets = Array.isArray(json.data) ? json.data : [json.data]
    for (const t of tickets) {
      if (t && typeof t === 'object' && (t as { status?: string }).status === 'error') {
        const details = (t as { details?: { error?: string } }).details
        return details?.error === 'DeviceNotRegistered' ? 'DeviceNotRegistered' : 'failed'
      }
    }
    return 'ok'
  } catch {
    return 'failed'
  }
}
