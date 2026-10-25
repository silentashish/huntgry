import {
  AUTOMATION_RUN_STATUS_LABEL,
  AUTOMATION_STEP_LABEL,
  WORKING_STEPS,
  type AutomationCandidate,
  type AutomationSettings,
  type AutomationState,
  type AutomationStep
} from '@shared/automation-types'
import type { FieldReport, FillReport } from '@shared/apply-types'
import type { UiTone } from '../../components/ui'

/**
 * What the Automation page (#154) shows, pure: the header's status pill, the sidebar badge, the page's
 * sections (Ready to submit, Needs you, the other candidates) and each row's texts.
 */

export interface Pill {
  label: string
  tone: UiTone
  /** A live state (running, waiting): the pill gets a dot. */
  live?: boolean
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** The header pill: Off, Waiting for the window, Running · step, Paused, Waiting: why, Stopped: why. */
export function statusPill(state: AutomationState | null): Pill {
  if (!state) return { label: 'Loading', tone: 'neutral' }
  const run = state.run
  if (run) {
    if (run.status === 'running') {
      const current = run.current ? state.candidates[run.current] : undefined
      const step = current && WORKING_STEPS.has(current.step) ? ` · ${AUTOMATION_STEP_LABEL[current.step]}` : ''
      return { label: `Running${step}`, tone: 'trail', live: true }
    }
    if (run.status === 'paused') return { label: 'Paused', tone: 'warning' }
    if (run.status === 'waiting') return { label: run.message ? `Waiting: ${run.message}` : 'Waiting', tone: 'info', live: true }
    return { label: AUTOMATION_RUN_STATUS_LABEL[run.status], tone: run.status.startsWith('stopped') ? 'danger' : 'success' }
  }
  if (state.paused) return { label: 'Paused', tone: 'warning' }
  if (state.enabled) {
    return state.nextWindowAt
      ? { label: `Waiting for window · opens at ${clock(state.nextWindowAt)}`, tone: 'info' }
      : { label: 'Run window open', tone: 'trail' }
  }
  const last = state.lastRun
  if (last && last.status.startsWith('stopped')) return { label: AUTOMATION_RUN_STATUS_LABEL[last.status], tone: 'neutral' }
  return { label: 'Off', tone: 'neutral' }
}

/** The sidebar badge: jobs ready to submit, warning tone when any job needs you; `null` hides it. */
export function automationBadge(state: AutomationState | null): { count: number; label: string; tone: 'accent' | 'warning' } | null {
  if (!state) return null
  const all = Object.values(state.candidates)
  const ready = all.filter((c) => c.step === 'ready').length
  const needs = all.filter((c) => c.step === 'needs-you').length
  if (!ready && !needs) return null
  const parts = [ready && `${ready} ready to submit`, needs && `${needs} need${needs === 1 ? 's' : ''} you`].filter(Boolean)
  return { count: ready || needs, label: parts.join(', '), tone: needs ? 'warning' : 'accent' }
}

export interface Sections {
  ready: AutomationCandidate[]
  needsYou: AutomationCandidate[]
  /** Everything else: working first, then selected, submitted, skipped. */
  others: AutomationCandidate[]
}

const OTHER_RANK: Partial<Record<AutomationStep, number>> = { selected: 1, submitted: 2, skipped: 3 }
const rank = (step: AutomationStep) => (WORKING_STEPS.has(step) ? 0 : (OTHER_RANK[step] ?? 4))
const newest = (a: AutomationCandidate, b: AutomationCandidate) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key)

export function sectionsOf(state: AutomationState | null): Sections {
  const all = state ? Object.values(state.candidates) : []
  return {
    ready: all.filter((c) => c.step === 'ready').sort(newest),
    needsYou: all.filter((c) => c.step === 'needs-you').sort(newest),
    others: all
      .filter((c) => c.step !== 'ready' && c.step !== 'needs-you')
      .sort((a, b) => rank(a.step) - rank(b.step) || (b.match?.score ?? -1) - (a.match?.score ?? -1) || newest(a, b))
  }
}

export const SOURCE_LABEL: Record<string, string> = { jobs: 'Saved jobs', explore: 'Explore' }

export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source

export const STEP_TONE: Record<AutomationStep, UiTone> = {
  selected: 'neutral',
  saving: 'info',
  link: 'info',
  description: 'info',
  scoring: 'info',
  tailoring: 'trail',
  filling: 'trail',
  ready: 'accent',
  submitted: 'success',
  skipped: 'neutral',
  'needs-you': 'warning'
}

/** The row's first reason (the cap or skip reason comes first), or a dash. */
export const firstReason = (c: AutomationCandidate) => c.reasons[0] ?? '—'

/** The hover text of a row's reasons: every reason, the matched and missing requirements, failed gates. */
export function reasonsDetail(c: AutomationCandidate): string {
  const lines = [...c.reasons]
  if (c.match) {
    if (c.match.matched.length) lines.push(`Matched: ${c.match.matched.join(', ')}`)
    if (c.match.missing.length) lines.push(`Missing: ${c.match.missing.join(', ')}`)
    for (const g of c.match.gates) lines.push(`Gate: ${g.reason}`)
  }
  return lines.join('\n')
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(iso: string, now: number): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export const money = (n: number) => `$${n.toFixed(2)}`

/** Local YYYY-MM-DD. */
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** "4 of 10 today · $3.10 of $15.00 this run". */
export function countersText(state: AutomationState, settings: AutomationSettings, now = new Date()): string {
  const today = state.day.date === localDay(now) ? state.day.started : 0
  const cost = state.run?.costUsd ?? 0
  return `${today} of ${settings.perDay} today · ${money(cost)} of ${money(settings.maxCostUsd)} this run`
}

/** Report lines a model wrote (AI answers and drafts), for the Ready card. */
export function aiLines(report: FillReport | null | undefined): FieldReport[] {
  return (report?.fields ?? []).filter((f) => f.outcome === 'filled' && (f.suggestedBy === 'model' || f.suggestedBy === 'draft'))
}

/** Required lines nothing filled, for the Ready card. */
export function openRequiredLines(report: FillReport | null | undefined): FieldReport[] {
  return (report?.fields ?? []).filter((f) => f.required && !['filled', 'uploaded', 'kept', 'to-upload'].includes(f.outcome))
}

export const titleOf = (c: Pick<AutomationCandidate, 'title' | 'company'>) => [c.title, c.company].filter(Boolean).join(' · ')

export const stepLabel = (step: AutomationStep) => AUTOMATION_STEP_LABEL[step]
