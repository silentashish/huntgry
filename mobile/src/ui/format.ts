/**
 * Small formatters for the screens (pure, tested in Node): the date eyebrow, relative times,
 * durations, token counts, money, and the queue card meta line.
 */

import type { RemoteAgentId, RemoteQueueItem, RemoteQueueItemStatus, RemoteRun, RemoteRunStatus } from '@huntgry/remote-protocol'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const AGENT_LABEL: Record<RemoteAgentId, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }

/** "Tuesday · 7 Oct" */
export function dayLine(now: Date): string {
  return `${DAYS[now.getDay()]} · ${now.getDate()} ${MONTHS[now.getMonth()]}`
}

/** "14:05" */
export function clock(iso: string | number): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "now", "23 min ago", "3 h ago", "2 d ago" */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

/** "4m 12s", "1h 05m", "12s" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** "61k tok", "980 tok", "1.2M tok" */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M tok`
  if (n >= 1000) return `${Math.round(n / 1000)}k tok`
  return `${n} tok`
}

/** "$0.44" */
export function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** "starts in 5 min", "starts in 40 s", "starts in 2 h" */
export function startsIn(iso: string, now: number): string | null {
  const s = Math.round((Date.parse(iso) - now) / 1000)
  if (s <= 0) return null
  if (s >= 3600) return `starts in ${Math.round(s / 3600)} h`
  if (s >= 120) return `starts in ${Math.round(s / 60)} min`
  return `starts in ${s} s`
}

/** The mono line under a queue card's title. */
export function queueMeta(item: RemoteQueueItem, run: RemoteRun | undefined, now: number): string {
  const parts: string[] = []
  if (run && (item.status === 'running' || item.status === 'needs-reply' || item.status === 'preparing' || item.status === 'done' || item.status === 'failed')) {
    const end = run.live ? now : Date.parse(run.updatedAt)
    parts.push(duration(end - Date.parse(run.createdAt)))
    if (run.usage) parts.push(tokens(run.usage.inputTokens + run.usage.outputTokens))
    if (run.costUsd > 0) parts.push(money(run.costUsd))
  }
  if (item.status === 'queued') {
    const wait = item.notBefore ? startsIn(item.notBefore, now) : null
    if (wait) parts.push(wait)
    if (item.attempts > 1) parts.push(`attempt ${item.attempts}`)
    if (parts.length === 0) parts.push('waiting for a free slot')
  }
  if (item.status === 'preparing' && parts.length === 0) parts.push('preparing')
  if (item.built && item.status !== 'done') parts.push('resume built')
  return parts.join(' · ')
}

export const QUEUE_STATUS: Record<RemoteQueueItemStatus, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'; live: boolean }> = {
  queued: { label: 'Queued', tone: 'neutral', live: false },
  preparing: { label: 'Preparing', tone: 'info', live: true },
  running: { label: 'Working', tone: 'info', live: true },
  'needs-reply': { label: 'Needs your reply', tone: 'warning', live: false },
  done: { label: 'Done', tone: 'success', live: false },
  failed: { label: 'Failed', tone: 'danger', live: false },
  cancelled: { label: 'Cancelled', tone: 'neutral', live: false }
}

export const RUN_STATUS: Record<RemoteRunStatus, { badge: string; eyebrow: string; tone: 'info' | 'warning' | 'success' | 'danger' | 'neutral'; live: boolean }> = {
  running: { badge: 'Working', eyebrow: 'working', tone: 'info', live: true },
  waiting: { badge: 'Waiting', eyebrow: 'waiting for you', tone: 'warning', live: false },
  finished: { badge: 'Finished', eyebrow: 'finished', tone: 'success', live: false },
  failed: { badge: 'Failed', eyebrow: 'failed', tone: 'danger', live: false },
  stopped: { badge: 'Stopped', eyebrow: 'stopped', tone: 'neutral', live: false }
}

/** Active = the desktop's cancel rule (queued, preparing, running, needs-reply). */
export function canCancel(item: RemoteQueueItem): boolean {
  return item.status === 'queued' || item.status === 'preparing' || item.status === 'running' || item.status === 'needs-reply'
}

/** The desktop's retry rule: failed or cancelled, and no other active item for the same job. */
export function canRetry(item: RemoteQueueItem, all: readonly RemoteQueueItem[]): boolean {
  if (item.status !== 'failed' && item.status !== 'cancelled') return false
  return !all.some((other) => other !== item && other.jobId === item.jobId && canCancel(other))
}

export function isToday(iso: string, now: number): boolean {
  const a = new Date(iso)
  const b = new Date(now)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Queued / working / done-today counts for the Home tiles and the Queue eyebrow. */
export function queueCounts(items: readonly RemoteQueueItem[], more: number, now: number): { queued: number; working: number; doneToday: number } {
  let queued = more
  let working = 0
  let doneToday = 0
  for (const i of items) {
    if (i.status === 'queued') queued++
    else if (i.status === 'preparing' || i.status === 'running' || i.status === 'needs-reply') working++
    else if (i.status === 'done' && isToday(i.updatedAt, now)) doneToday++
  }
  return { queued, working, doneToday }
}

/** The relay host for display ("huntgry-relay.ashish.workers.dev"). */
export function relayHost(relay: string): string {
  return relay.replace(/^https:\/\//, '').replace(/\/.*$/, '')
}
