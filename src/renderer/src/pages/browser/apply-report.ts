import { FACTS, isDecline } from '@shared/apply-facts'
import type { AdapterStep, ApplySession, ApplyStatus, FieldReport, FillOutcome, FillReport } from '@shared/apply-types'

/** Display helpers for the Apply panel (pure, unit-tested). */

export const STATUS_META: Record<ApplyStatus, { label: string; color: string }> = {
  opened: { label: 'Loading page', color: 'blue' },
  ready: { label: 'Ready to fill', color: 'blue' },
  waiting: { label: 'Your turn in the page', color: 'yellow' },
  filling: { label: 'Filling', color: 'blue' },
  filled: { label: 'Filled: review and submit', color: 'teal' },
  'submitted-detected': { label: 'Submitted', color: 'teal' },
  blocked: { label: 'Human check', color: 'orange' },
  closed: { label: 'Tab closed', color: 'gray' },
  error: { label: 'Error', color: 'red' }
}

export const OUTCOME_META: Record<FillOutcome, { label: string; color: string }> = {
  filled: { label: 'Filled', color: 'teal' },
  uploaded: { label: 'Attached', color: 'teal' },
  kept: { label: 'Kept yours', color: 'gray' },
  'skipped-no-value': { label: 'Not in profile', color: 'orange' },
  'skipped-unsupported': { label: 'Your choice', color: 'gray' },
  unmatched: { label: 'Fill in', color: 'orange' },
  ambiguous: { label: 'Unsure', color: 'orange' },
  rejected: { label: 'Rejected', color: 'red' },
  'to-upload': { label: 'Pending', color: 'blue' },
  'upload-failed': { label: 'Attach yourself', color: 'red' }
}

const DONE: ReadonlySet<FillOutcome> = new Set<FillOutcome>(['filled', 'uploaded', 'kept'])

export interface ReportGroup {
  title: string
  fields: FieldReport[]
}

/**
 * A choice Huntgry can learn (#71): it asks for a known fact or carries a suggestion. It needs the user once, so it
 * is listed under "Needs you" with its answer control, not among the plain choices.
 */
const learnable = (f: FieldReport) => f.outcome === 'skipped-unsupported' && (f.fact !== undefined || f.suggestion !== undefined)

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
  return [
    { title: 'Needs you', fields: needs },
    { title: 'Filled', fields: done },
    { title: 'Your choice', fields: choices }
  ].filter((g) => g.fields.length > 0)
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
