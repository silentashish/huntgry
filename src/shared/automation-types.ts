import type { FieldReport, FillReport } from './apply-types'
import type { MatchGate, MatchSource } from './match-score'

/**
 * Automation (#154): Huntgry prepares applications for the jobs that match well, unattended (e.g.
 * overnight), and stops before Submit. It picks candidates from saved Jobs and the Explore cache, and for
 * each one drives the existing services in order: employer link (#146), full description (#148),
 * match score (#149), tailoring through the unattended pipeline (#31), and autofill (#24) in a hidden tab.
 * The job then waits in "Ready to submit" until the user opens the filled form and presses the site's
 * Submit button. A failed step leaves the job in "Needs you"; nothing is retried automatically.
 *
 * State: `<workspace>/.huntgry/automation.json`, the step log `<workspace>/.huntgry/automation-log.jsonl`,
 * prepared fills `<workspace>/.huntgry/automation/prepared/`. Settings and caps live in
 * `userData/settings.json` (`automation`), out of reach of a prompt-injected agent writing into the workspace.
 */

export type AutomationStep =
  /** Passed selection; waits its turn. */
  | 'selected'
  /** An Explore row being saved to Jobs. */
  | 'saving'
  /** The employer link, from the Jobright page (#146). */
  | 'link'
  /** The full description (#148's Jobright summary fallback inside). */
  | 'description'
  /** The match score on the full description: threshold, requirements and gates again. */
  | 'scoring'
  /** The unattended pipeline is tailoring it (#31, #158). */
  | 'tailoring'
  /** The apply form is being filled in a hidden tab (autofill and AI drafts); never submitted. */
  | 'filling'
  /** Ready to submit: waits for the user. */
  | 'ready'
  /** The site's confirmation page showed after the user pressed Submit. */
  | 'submitted'
  /** Not picked (below the threshold, a gate, a cap…); `reasons` says why. */
  | 'skipped'
  /** A step failed; `failedStep` and `error` say which and why. Never retried automatically. */
  | 'needs-you'

export const AUTOMATION_STEPS: readonly AutomationStep[] = [
  'selected',
  'saving',
  'link',
  'description',
  'scoring',
  'tailoring',
  'filling',
  'ready',
  'submitted',
  'skipped',
  'needs-you'
]

/** Steps a candidate is worked on in; at most one candidate is in one of them at a time. */
export const WORKING_STEPS: ReadonlySet<AutomationStep> = new Set(['saving', 'link', 'description', 'scoring', 'tailoring', 'filling'])

/** Steps selection never picks again (the user decides what happens next). */
export const SETTLED_STEPS: ReadonlySet<AutomationStep> = new Set(['ready', 'submitted', 'needs-you'])

export const AUTOMATION_STEP_LABEL: Record<AutomationStep, string> = {
  selected: 'Selected',
  saving: 'Saving to Jobs',
  link: 'Employer link',
  description: 'Reading the description',
  scoring: 'Scoring',
  tailoring: 'Tailoring',
  filling: 'Filling the form',
  ready: 'Ready to submit',
  submitted: 'Submitted',
  skipped: 'Skipped',
  'needs-you': 'Needs you'
}

export interface AutomationMatch {
  score: number
  /** Matched plus missing requirements. */
  requirements: number
  matched: string[]
  missing: string[]
  gates: MatchGate[]
  source: MatchSource
}

/** What the Ready to submit card shows of a prepared fill. */
export interface PreparedSummary {
  ats: FillReport['ats']
  url: string
  filled: number
  /** Lines Huntgry wrote from a model (AI answers and drafts): the user checks them before Submit. */
  ai: number
  /** Required lines left for the user. */
  openRequired: number
  /** Files attached when the user opens the form (never during the unattended fill). */
  uploadsDeferred: number
  preparedAt: string
}

export interface AutomationCandidate {
  /** Stable: the saved job id, or `explore:<row id>` until the row is saved. */
  key: string
  source: 'jobs' | 'explore' | (string & {})
  /** The saved job, once there is one. */
  jobId?: string
  title: string
  company: string
  /** The posting date (ISO), for ordering. */
  postedAt?: string
  match?: AutomationMatch
  /** Why it was picked or skipped: Relevant reasons, the match, a gate, a cap. */
  reasons: string[]
  step: AutomationStep
  /** With `needs-you`: the step that failed. */
  failedStep?: AutomationStep
  /** With `needs-you`: what went wrong, for the user. */
  error?: string
  /** A skip that holds until the job's description changes (scored below the threshold on the full posting). */
  final?: boolean
  queueItemId?: string
  runId?: string
  applicationId?: string
  /** Tailoring cost (estimated from tokens for every agent). */
  costUsd?: number
  prepared?: PreparedSummary
  /** The automation run that worked on it last. */
  automationRunId?: string
  /** After Retry: the step the one more attempt starts from. */
  retryFrom?: AutomationStep
  updatedAt: string
}

export type AutomationRunStatus =
  | 'running'
  | 'paused'
  /** Holding: the run window closed, another pipeline is running, the user has an apply session open. */
  | 'waiting'
  | 'stopped-cost'
  | 'stopped-cap'
  | 'stopped'
  | 'finished'

export interface AutomationRun {
  id: string
  startedAt: string
  endedAt?: string
  status: AutomationRunStatus
  /** "Run now" (the window does not apply) or the run window. */
  trigger: 'now' | 'window'
  /** What it waits for, or why it stopped. */
  message?: string
  /** Tailoring cost so far (estimated from tokens). */
  costUsd: number
  /** Jobright pages loaded for Explore rows this run (the ToS bound). */
  pageLoads: number
  /** Picked candidate keys, in order. */
  candidates: string[]
  /** The candidate being worked on. */
  current?: string
}

export interface AutomationState {
  version: 1
  /** The run window starts runs by itself. */
  enabled: boolean
  /** Nothing new starts until Resume. */
  paused: boolean
  /** When the run window opens next (ISO), or null when it is open now, off or anytime. */
  nextWindowAt: string | null
  run: AutomationRun | null
  lastRun: AutomationRun | null
  candidates: Record<string, AutomationCandidate>
  /** Jobs that entered tailoring on the local day `date` (YYYY-MM-DD), across runs. */
  day: { date: string; started: number }
}

export type AutomationWindow = { mode: 'anytime' } | { mode: 'window'; start: string; end: string }

export interface AutomationSettings {
  /** Lowest match score picked (#149 calibration: 80). */
  threshold: number
  /** Fewest requirements a job must name (a job naming 1–2 skills scores 0 or 100). */
  minRequirements: number
  /** Most jobs per company: ready, in flight, and applied to in the last 30 days. */
  perCompany: number
  /** Most jobs entering tailoring per local day, across runs. */
  perDay: number
  /** Most tailoring cost per run, in dollars (estimated from tokens). */
  maxCostUsd: number
  window: AutomationWindow
  sources: { jobs: boolean; explore: boolean }
  /** Most Jobright pages loaded per run for Explore rows (saving, link, summary). */
  maxExplorePageLoads: number
  /** Write cover letters too. */
  coverLetter: boolean
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  threshold: 80,
  minRequirements: 4,
  perCompany: 2,
  perDay: 10,
  maxCostUsd: 15,
  window: { mode: 'window', start: '22:00', end: '07:00' },
  sources: { jobs: true, explore: true },
  maxExplorePageLoads: 20,
  coverLetter: true
}

/** Bounds the page and `normalizeAutomationSettings` clamp to. */
export const AUTOMATION_BOUNDS = {
  threshold: { min: 50, max: 100 },
  minRequirements: { min: 1, max: 20 },
  perCompany: { min: 1, max: 10 },
  perDay: { min: 1, max: 50 },
  maxCostUsd: { min: 0.5, max: 200 },
  maxExplorePageLoads: { min: 0, max: 100 }
} as const

/** A company's earlier applications count against `perCompany` for this many days. */
export const PER_COMPANY_DAYS = 30

export interface AutomationLogEntry {
  at: string
  runId: string
  /** Candidate key; empty for the run's own lines. */
  key: string
  /** "Title · Company", so the log reads on its own. */
  title?: string
  step: AutomationStep | 'run'
  outcome: 'start' | 'ok' | 'skip' | 'fail' | 'info'
  message: string
  costUsd?: number
}

/** A prepared fill, persisted so the Ready card and the one-click open survive a restart. */
export interface PreparedFill {
  version: 1
  applicationId: string
  url: string
  report: FillReport
  /** AI drafts typed into open-ended questions (#82), by question key. */
  drafts: Record<string, string>
  /** This application's own model answers (#136), by question key. */
  aiOnce: Record<string, { fact: string | null; value: string }>
  /** Pages (URL plus step title) that had their model calls. */
  mappedSteps: string[]
  draftedSteps: string[]
  /** Question keys already sent to the model. */
  asked: string[]
  preparedAt: string
}

export interface AutomationPreview {
  picked: AutomationCandidate[]
  skipped: AutomationCandidate[]
}

export interface AutomationSettingsPatch {
  threshold?: number
  minRequirements?: number
  perCompany?: number
  perDay?: number
  maxCostUsd?: number
  window?: AutomationWindow
  sources?: Partial<AutomationSettings['sources']>
  maxExplorePageLoads?: number
  coverLetter?: boolean
}

export interface AutomationApi {
  state(): Promise<AutomationState>
  settings(): Promise<AutomationSettings>
  updateSettings(patch: AutomationSettingsPatch): Promise<AutomationSettings>
  /** Turns the run window on or off. */
  setEnabled(on: boolean): Promise<AutomationState>
  /** Holds before the next step (and pauses the automation's pipeline). */
  pause(): Promise<AutomationState>
  resume(): Promise<AutomationState>
  /** Starts a run now, outside the window; the caps still apply. */
  runNow(): Promise<AutomationState>
  /** Ends the run after the current step. */
  stop(): Promise<AutomationState>
  /** What a run would pick now, without loading anything. */
  preview(): Promise<AutomationPreview>
  /** One more attempt of a Needs you job's failed step. */
  retry(key: string): Promise<AutomationState>
  /** Dismisses the job (Jobs' Dismiss) and drops it from Automation. */
  dismiss(key: string): Promise<AutomationState>
  log(options?: { limit?: number; key?: string }): Promise<AutomationLogEntry[]>
  /** The prepared fill of a Ready to submit job, for its card. */
  prepared(key: string): Promise<PreparedFill | null>
  /**
   * "Review & submit": approves the result through the review service (the user's decision), then opens the
   * apply session with the prepared answers. The renderer shows the Browser page afterwards.
   */
  openPrepared(key: string): Promise<void>
}

export const AUTOMATION_CHANNELS = {
  state: 'automation:state',
  settings: 'automation:settings',
  updateSettings: 'automation:update-settings',
  setEnabled: 'automation:set-enabled',
  pause: 'automation:pause',
  resume: 'automation:resume',
  runNow: 'automation:run-now',
  stop: 'automation:stop',
  preview: 'automation:preview',
  retry: 'automation:retry',
  dismiss: 'automation:dismiss',
  log: 'automation:log',
  prepared: 'automation:prepared',
  openPrepared: 'automation:open-prepared'
} as const

export interface AutomationEvents {
  'automation:changed': AutomationState
  'automation:step': AutomationLogEntry
}

/** The log keeps this many lines on the page. */
export const AUTOMATION_LOG_LIMIT = 200

export const EMPTY_AUTOMATION_STATE: AutomationState = {
  version: 1,
  enabled: false,
  paused: false,
  nextWindowAt: null,
  run: null,
  lastRun: null,
  candidates: {},
  day: { date: '', started: 0 }
}

/** Counts of a prepared report, for the card. */
export function preparedSummary(report: FillReport, preparedAt: string): PreparedSummary {
  const fields = report.fields
  const count = (pred: (f: FieldReport) => boolean) => fields.filter(pred).length
  return {
    ats: report.ats,
    url: report.url,
    filled: count((f) => f.outcome === 'filled' || f.outcome === 'uploaded'),
    ai: count((f) => f.outcome === 'filled' && (f.suggestedBy === 'model' || f.suggestedBy === 'draft')),
    openRequired: count((f) => f.required && !['filled', 'uploaded', 'kept', 'to-upload'].includes(f.outcome)),
    uploadsDeferred: count((f) => f.outcome === 'to-upload'),
    preparedAt
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const clamp = (v: unknown, { min, max }: { min: number; max: number }, fallback: number, integer = true): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const n = integer ? Math.round(v) : Math.round(v * 100) / 100
  return Math.min(max, Math.max(min, n))
}

export function normalizeWindow(v: unknown, fallback: AutomationWindow = DEFAULT_AUTOMATION_SETTINGS.window): AutomationWindow {
  const w = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  if (w.mode === 'anytime') return { mode: 'anytime' }
  if (w.mode === 'window' && typeof w.start === 'string' && typeof w.end === 'string' && HHMM.test(w.start) && HHMM.test(w.end) && w.start !== w.end)
    return { mode: 'window', start: w.start, end: w.end }
  return fallback
}

/** Settings with defaults; numbers are clamped to `AUTOMATION_BOUNDS`, anything unreadable takes its default. */
export function normalizeAutomationSettings(input: unknown): AutomationSettings {
  const s = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const d = DEFAULT_AUTOMATION_SETTINGS
  const b = AUTOMATION_BOUNDS
  const sources = (typeof s.sources === 'object' && s.sources !== null ? s.sources : {}) as Record<string, unknown>
  return {
    threshold: clamp(s.threshold, b.threshold, d.threshold),
    minRequirements: clamp(s.minRequirements, b.minRequirements, d.minRequirements),
    perCompany: clamp(s.perCompany, b.perCompany, d.perCompany),
    perDay: clamp(s.perDay, b.perDay, d.perDay),
    maxCostUsd: clamp(s.maxCostUsd, b.maxCostUsd, d.maxCostUsd, false),
    window: normalizeWindow(s.window),
    sources: {
      jobs: typeof sources.jobs === 'boolean' ? sources.jobs : d.sources.jobs,
      explore: typeof sources.explore === 'boolean' ? sources.explore : d.sources.explore
    },
    maxExplorePageLoads: clamp(s.maxExplorePageLoads, b.maxExplorePageLoads, d.maxExplorePageLoads),
    coverLetter: typeof s.coverLetter === 'boolean' ? s.coverLetter : d.coverLetter
  }
}

/** Checks a patch from the renderer: unknown keys are dropped, a wrong type or a bad window throws. */
export function requireSettingsPatch(input: unknown): AutomationSettingsPatch {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid automation settings.')
  const p = input as Record<string, unknown>
  const out: AutomationSettingsPatch = {}
  for (const key of ['threshold', 'minRequirements', 'perCompany', 'perDay', 'maxCostUsd', 'maxExplorePageLoads'] as const) {
    if (p[key] === undefined) continue
    if (typeof p[key] !== 'number' || !Number.isFinite(p[key])) throw new Error(`Invalid ${key}.`)
    out[key] = p[key] as number
  }
  if (p.window !== undefined) {
    const w = normalizeWindow(p.window, { mode: 'anytime' })
    if (w.mode === 'anytime' && (p.window as { mode?: unknown })?.mode !== 'anytime') throw new Error('The run window needs a start and an end time (HH:MM), not the same.')
    out.window = w
  }
  if (p.sources !== undefined) {
    if (typeof p.sources !== 'object' || p.sources === null) throw new Error('Invalid sources.')
    const s = p.sources as Record<string, unknown>
    out.sources = {}
    for (const key of ['jobs', 'explore'] as const) {
      if (s[key] === undefined) continue
      if (typeof s[key] !== 'boolean') throw new Error(`Invalid source ${key}.`)
      out.sources[key] = s[key] as boolean
    }
  }
  if (p.coverLetter !== undefined) {
    if (typeof p.coverLetter !== 'boolean') throw new Error('Invalid coverLetter.')
    out.coverLetter = p.coverLetter
  }
  return out
}

export function requireCandidateKey(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 300) throw new Error('Invalid automation job.')
  return v
}

/** The status pill: what the header says about the run window and the run. */
export const AUTOMATION_RUN_STATUS_LABEL: Record<AutomationRunStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  waiting: 'Waiting',
  'stopped-cost': 'Stopped: cost cap',
  'stopped-cap': 'Stopped: daily cap',
  stopped: 'Stopped',
  finished: 'Finished'
}
