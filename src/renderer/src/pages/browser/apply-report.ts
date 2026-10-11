import { FACTS, isDecline } from '@shared/apply-facts'
import type { AdapterStep, ApplySession, ApplyStatus, FieldReport, FillOutcome, FillReport } from '@shared/apply-types'
import type { UiTone } from '../../components/ui'

/** Display helpers for the Apply panel (pure, unit-tested). */

/** A pill: its text and Scent Trail tone. */
export interface PillMeta {
  label: string
  tone: UiTone
}

export const STATUS_META: Record<ApplyStatus, PillMeta> = {
  opened: { label: 'Loading page', tone: 'info' },
  ready: { label: 'Ready to fill', tone: 'info' },
  waiting: { label: 'Your turn in the page', tone: 'warning' },
  filling: { label: 'Filling', tone: 'info' },
  filled: { label: 'Filled: review and submit', tone: 'trail' },
  'submitted-detected': { label: 'Submitted', tone: 'success' },
  blocked: { label: 'Human check', tone: 'accent' },
  closed: { label: 'Tab closed', tone: 'neutral' },
  error: { label: 'Error', tone: 'danger' }
}

export const OUTCOME_META: Record<FillOutcome, PillMeta> = {
  filled: { label: 'Filled', tone: 'trail' },
  uploaded: { label: 'Attached', tone: 'trail' },
  kept: { label: 'Kept yours', tone: 'neutral' },
  'skipped-no-value': { label: 'Not in profile', tone: 'warning' },
  'skipped-unsupported': { label: 'Your choice', tone: 'neutral' },
  unmatched: { label: 'Fill in', tone: 'warning' },
  ambiguous: { label: 'Unsure', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },
  'to-upload': { label: 'Pending', tone: 'info' },
  'upload-failed': { label: 'Attach yourself', tone: 'danger' }
}

const DONE: ReadonlySet<FillOutcome> = new Set<FillOutcome>(['filled', 'uploaded', 'kept'])

export type ReportGroupTitle = 'Needs you' | 'Filled' | 'Your choice'

export interface ReportGroup {
  title: ReportGroupTitle
  fields: FieldReport[]
}

/** The tone of a group's count pill: what waits for the user is warning, what is done is trail. */
export const GROUP_TONE: Record<ReportGroupTitle, UiTone> = {
  'Needs you': 'warning',
  Filled: 'trail',
  'Your choice': 'neutral'
}

/**
 * A choice Huntgry can learn (#71): it asks for a known fact or carries a suggestion. It needs the user once, so it
 * is listed under "Needs you" with its answer control, not among the plain choices.
 */
const learnable = (f: FieldReport) => f.outcome === 'skipped-unsupported' && (f.fact !== undefined || f.suggestion !== undefined)

/** The badge of a report line: its outcome's, "AI draft" for a drafted answer (#82), or "Answer once" for a choice Huntgry can learn. */
export function badgeOf(f: FieldReport): PillMeta {
  if (f.suggestedBy === 'draft' && f.outcome === 'filled') return { label: 'AI draft', tone: 'review' }
  return learnable(f) ? { label: 'Answer once', tone: 'warning' } : OUTCOME_META[f.outcome]
}

/** "Needs you" (required first), "Filled", "Your choice"; empty groups are left out. */
export function groupReport(report: FillReport | null): ReportGroup[] {
  if (!report) return []
  const needs = report.fields
    .filter((f) => !DONE.has(f.outcome) && (f.outcome !== 'skipped-unsupported' || learnable(f)))
    .sort((a, b) => Number(b.required) - Number(a.required))
  const done = report.fields.filter((f) => DONE.has(f.outcome))
  const choices = report.fields
    .filter((f) => f.outcome === 'skipped-unsupported' && !learnable(f))
    .sort((a, b) => Number(b.required) - Number(a.required))
  const groups: ReportGroup[] = [
    { title: 'Needs you', fields: needs },
    { title: 'Filled', fields: done },
    { title: 'Your choice', fields: choices }
  ]
  return groups.filter((g) => g.fields.length > 0)
}

const STEP_LABEL: Record<AdapterStep, string> = {
  posting: 'Job posting',
  choice: 'How to apply',
  'account-wall': 'Sign in or create account',
  form: 'Application form',
  other: 'Other step'
}

/** "Step: My Information", "Step: Sign in or create account (Create Account/Sign In)"; null when the site has no steps. */
export function stepLabel(step: ApplySession['step']): string | null {
  if (!step) return null
  const kind = STEP_LABEL[step.kind]
  if (step.kind === 'form') return `Step: ${step.title ?? kind}`
  return step.title && step.title !== kind ? `Step: ${kind} (${step.title})` : `Step: ${kind}`
}

/** Whether the panel offers to answer this line (#71): a question the page reported with an id, not yet answered. */
export function canAnswer(field: FieldReport): boolean {
  if (!field.fieldId || !field.question) return false
  return field.outcome !== 'filled' && field.outcome !== 'kept'
}

/** The answer control's choices: the page's options, "decline" first for sensitive (EEO) questions. */
export function answerChoices(field: FieldReport): string[] {
  const options = field.options ?? []
  if (!field.fact || !FACTS[field.fact].sensitive) return options
  return [...options.filter(isDecline), ...options.filter((o) => !isDecline(o))]
}

/** Where a suggestion comes from, for the line under the question. */
export function suggestionNote(field: FieldReport): string | null {
  if (!field.suggestion) return null
  if (field.suggestedBy === 'model') {
    const fact = field.fact ? FACTS[field.fact].label.toLowerCase() : 'a saved answer'
    return `Suggested: "${field.suggestion}" (AI matched this question to ${fact}; confirm it once).`
  }
  return `From your saved answers: "${field.suggestion}". Pick it in the page.`
}

/** Sensitive questions say where their answers go. */
export function isSensitive(field: FieldReport): boolean {
  return field.fact !== undefined && FACTS[field.fact].sensitive
}
