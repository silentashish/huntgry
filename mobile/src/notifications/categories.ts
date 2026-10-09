/**
 * The five notification categories on the phone side (#39): what Settings calls them, the
 * Android channel each one is delivered on, and which screen a tap opens. Plain TypeScript
 * (no React Native) so routing is unit-tested in Node.
 *
 * The relay sends `data: { category }` and nothing else (ADR-0001, "How a push happens"); the
 * screen fetches the content over the encrypted channel once it is open.
 */

import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@huntgry/remote-protocol'

/** Settings rows; the same words as the relay's fixed push bodies (`relay/src/push.ts`). */
export const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  'needs-reply': 'A run needs your reply',
  'usage-limit': 'Paused: usage limit',
  'pipeline-finished': 'Pipeline finished',
  'needs-review': 'Results need your review',
  failed: 'Something failed'
}

/** The body the relay sends when the desktop adds no `pushText` (details off, the default). */
export const GENERIC_BODY: Record<NotificationCategory, string> = { ...CATEGORY_LABEL }

export interface AndroidChannel {
  /** = the category; the relay sends `channelId: category`. */
  id: NotificationCategory
  name: string
  description: string
  /** `high` makes a heads-up notification; `default` only sounds. */
  importance: 'high' | 'default'
}

/**
 * One Android notification channel per category, so the owner can silence one kind in the
 * system settings too. Channel names are what Android shows under App info → Notifications.
 */
export const ANDROID_CHANNELS: readonly AndroidChannel[] = [
  { id: 'needs-reply', name: 'Runs waiting for you', description: 'A tailoring run asked a question and waits for your reply.', importance: 'high' },
  { id: 'usage-limit', name: 'Usage limit', description: 'The pipeline paused until the agent’s usage limit resets.', importance: 'default' },
  { id: 'pipeline-finished', name: 'Pipeline finished', description: 'An unattended pipeline finished.', importance: 'default' },
  { id: 'needs-review', name: 'Results to review', description: 'Tailored results are waiting for your review.', importance: 'default' },
  { id: 'failed', name: 'Failures', description: 'A run or the pipeline failed.', importance: 'high' }
]

/** The category of a notification's `data`, or null for anything else (never trust a payload). */
export function categoryOf(data: unknown): NotificationCategory | null {
  if (typeof data !== 'object' || data === null) return null
  const c = (data as { category?: unknown }).category
  return typeof c === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(c) ? (c as NotificationCategory) : null
}

/** expo-router hrefs of the tabs a tap can open. */
export const ROUTES = {
  home: '/',
  queue: '/queue',
  review: '/review',
  run: (id: string) => `/run/${encodeURIComponent(id)}`
} as const

/** What the router needs to know to pick a run. */
export interface RouteContext {
  queue: { items: { runId: string | null; status: string; updatedAt: string }[] } | null
  runInfo: Record<string, { id: string; status: string; updatedAt: string }>
}

export interface Route {
  href: string
  /** False when a better screen may appear once the phone has fresh data (a waiting run). */
  settled: boolean
}

/**
 * Which screen a tap on `category` opens:
 * - `needs-reply` → the run that waits (the most recently updated, from the queue or the runs
 *   the phone has seen); the Queue while none is known yet, settled once one is.
 * - `needs-review` → the Review tab.
 * - `usage-limit`, `pipeline-finished` → Home (the pipeline card and the usage-limit alert).
 * - `failed` → the Queue (failed jobs carry Retry there).
 */
export function routeFor(category: NotificationCategory, ctx: RouteContext): Route {
  switch (category) {
    case 'needs-reply': {
      const runId = waitingRun(ctx)
      return runId ? { href: ROUTES.run(runId), settled: true } : { href: ROUTES.queue, settled: false }
    }
    case 'needs-review':
      return { href: ROUTES.review, settled: true }
    case 'usage-limit':
    case 'pipeline-finished':
      return { href: ROUTES.home, settled: true }
    case 'failed':
      return { href: ROUTES.queue, settled: true }
  }
}

/**
 * The run waiting for a reply that changed last, if the phone knows one. The queue and the
 * runs seen (`run.changed`) may disagree; the newer of the two says whether a run still waits.
 */
export function waitingRun(ctx: RouteContext): string | null {
  const latest = new Map<string, { waiting: boolean; at: string }>()
  const see = (runId: string, waiting: boolean, at: string) => {
    const known = latest.get(runId)
    if (!known || at > known.at) latest.set(runId, { waiting, at })
  }
  for (const item of ctx.queue?.items ?? []) if (item.runId) see(item.runId, item.status === 'needs-reply', item.updatedAt)
  for (const run of Object.values(ctx.runInfo)) see(run.id, run.status === 'waiting', run.updatedAt)
  let best: { id: string; at: string } | null = null
  for (const [id, v] of latest) if (v.waiting && (!best || v.at > best.at)) best = { id, at: v.at }
  return best?.id ?? null
}
