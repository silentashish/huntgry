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

/**
 * `retry`: worth trying again later (network error, HTTP 429 or 5xx, Expo's `MessageRateExceeded`).
 * `failed`: will not get better by retrying (any other HTTP 4xx or ticket error).
 */
export type PushOutcome = 'ok' | 'DeviceNotRegistered' | 'retry' | 'failed'

/** A sent push: `ticketId` is set for an `ok` ticket, to look its receipt up later. */
export interface PushResult {
  outcome: PushOutcome
  ticketId?: string
  /** From a 429's `Retry-After`, capped at `MAX_RETRY_AFTER_MS`. */
  retryAfterMs?: number
}

/** A `Retry-After` longer than this is treated as this. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000

/** `Retry-After: <seconds>` or `<HTTP date>`, in ms from `now`; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
  if (!Number.isFinite(ms) || ms < 0) return undefined
  return Math.min(ms, MAX_RETRY_AFTER_MS)
}

/** Expo keeps receipts for a day; ids asked per receipts call (Expo allows 1000). */
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const RECEIPT_IDS_PER_CALL = 300

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
 * Sends one push and reports the ticket. Expo answers `{ data: [{ status, id, details }] }` for
 * an array request; `DeviceNotRegistered` means the token is dead and must be deleted. An `ok`
 * ticket only means Expo accepted the message: APNs / FCM may still report the token dead, in
 * the receipt for `ticketId` (`fetchReceipts`). Transient failures are `retry` (the room retries
 * them with a small budget, #70); anything else is `failed`.
 */
export async function sendExpoPush(url: string, message: PushMessage): Promise<PushResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify([message])
    })
    if (res.status === 429) return { outcome: 'retry', retryAfterMs: retryAfterMs(res.headers.get('retry-after')) }
    if (res.status >= 500) return { outcome: 'retry' }
    if (!res.ok) return { outcome: 'failed' }
    const json = (await res.json()) as { data?: unknown }
    const tickets = Array.isArray(json.data) ? json.data : [json.data]
    let ticketId: string | undefined
    for (const t of tickets) {
      if (!t || typeof t !== 'object') continue
      const ticket = t as { status?: string; id?: unknown; details?: { error?: string } }
      if (ticket.status === 'error') {
        const error = ticket.details?.error
        return { outcome: error === 'DeviceNotRegistered' ? 'DeviceNotRegistered' : error === 'MessageRateExceeded' ? 'retry' : 'failed' }
      }
      if (typeof ticket.id === 'string' && ticket.id.length > 0 && ticket.id.length <= 128) ticketId = ticket.id
    }
    return { outcome: 'ok', ticketId }
  } catch {
    // Network error or an unreadable body: transient as far as we can tell.
    return { outcome: 'retry' }
  }
}

/** What a receipt says about one ticket; tickets Expo has no receipt for yet are absent. */
export type ReceiptOutcome = 'ok' | 'DeviceNotRegistered' | 'failed'

/**
 * Looks up the receipts of `ids` (`POST getReceipts { ids }` → `{ data: { [id]: { status,
 * details } } }`). `null` when the call itself failed, so the caller keeps the ids for later.
 */
export async function fetchReceipts(url: string, ids: string[]): Promise<Map<string, ReceiptOutcome> | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ ids })
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: unknown }
    if (!json.data || typeof json.data !== 'object') return null
    const out = new Map<string, ReceiptOutcome>()
    for (const id of ids) {
      const r = (json.data as Record<string, { status?: string; details?: { error?: string } } | undefined>)[id]
      if (!r || typeof r !== 'object') continue
      out.set(id, r.status === 'ok' ? 'ok' : r.details?.error === 'DeviceNotRegistered' ? 'DeviceNotRegistered' : 'failed')
    }
    return out
  } catch {
    return null
  }
}
