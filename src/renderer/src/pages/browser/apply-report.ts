import type { ApplyStatus, FieldReport, FillOutcome, FillReport } from '@shared/apply-types'

/** Display helpers for the Apply panel (pure, unit-tested). */

export const STATUS_META: Record<ApplyStatus, { label: string; color: string }> = {
  opened: { label: 'Loading page', color: 'blue' },
  ready: { label: 'Ready to fill', color: 'blue' },
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

/** "Needs you" (required first), "Filled", "Your choice"; empty groups are left out. */
export function groupReport(report: FillReport | null): ReportGroup[] {
  if (!report) return []
  const needs = report.fields
    .filter((f) => !DONE.has(f.outcome) && f.outcome !== 'skipped-unsupported')
    .sort((a, b) => Number(b.required) - Number(a.required))
  const done = report.fields.filter((f) => DONE.has(f.outcome))
  const choices = report.fields
    .filter((f) => f.outcome === 'skipped-unsupported')
    .sort((a, b) => Number(b.required) - Number(a.required))
  return [
    { title: 'Needs you', fields: needs },
    { title: 'Filled', fields: done },
    { title: 'Your choice', fields: choices }
  ].filter((g) => g.fields.length > 0)
}
