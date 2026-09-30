import type { ApplyAts, FieldKey, FieldKind, FieldReport, FillOutcome, FillReport, PageScan } from '@shared/apply-types'

/**
 * Shape checks for what a browser tab sends back. The tab runs a job site
 * next to our preload, so its messages are treated as untrusted: only known
 * enum values, bounded strings, at most 200 fields.
 */

const ATS: readonly ApplyAts[] = ['greenhouse', 'lever', 'generic']
const KEYS: readonly FieldKey[] = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'location',
  'linkedin',
  'github',
  'website',
  'currentCompany',
  'resume',
  'coverLetter'
]
const KINDS: readonly FieldKind[] = ['text', 'textarea', 'file', 'select', 'checkbox', 'radio', 'combobox', 'other']
const OUTCOMES: readonly FillOutcome[] = [
  'filled',
  'kept',
  'skipped-no-value',
  'skipped-unsupported',
  'unmatched',
  'ambiguous',
  'rejected',
  'to-upload',
  'uploaded',
  'upload-failed'
]

const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('The page sent an invalid reply.')
  return v as Record<string, unknown>
}
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const oneOf = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const httpUrl = (v: unknown): string => {
  const s = str(v, 2000)
  return /^https?:\/\//i.test(s) ? s : ''
}

export function parsePageScan(input: unknown): PageScan {
  const o = obj(input)
  const embed = httpUrl(o.embedUrl)
  return {
    ats: oneOf(o.ats, ATS, 'generic'),
    url: httpUrl(o.url),
    title: str(o.title, 300),
    text: str(o.text, 3000),
    confirmation: o.confirmation === true,
    formFound: o.formFound === true,
    hasResumeInput: o.hasResumeInput === true,
    embedUrl: embed || null
  }
}

function parseField(input: unknown): FieldReport {
  const o = obj(input)
  const field: FieldReport = {
    key: KEYS.includes(o.key as FieldKey) ? (o.key as FieldKey) : null,
    label: str(o.label, 160),
    kind: oneOf(o.kind, KINDS, 'other'),
    required: o.required === true,
    // A page cannot claim an upload happened; only main sets uploaded / upload-failed.
    outcome: oneOf(o.outcome, OUTCOMES.filter((x) => x !== 'uploaded' && x !== 'upload-failed'), 'unmatched')
  }
  if (typeof o.value === 'string') field.value = o.value.slice(0, 200)
  if (typeof o.reason === 'string') field.reason = o.reason.slice(0, 200)
  // Only resume / cover letter file fields may ask for an upload.
  if (field.outcome === 'to-upload' && (field.kind !== 'file' || (field.key !== 'resume' && field.key !== 'coverLetter'))) {
    field.outcome = 'unmatched'
  }
  return field
}

export function parseFillReport(input: unknown): FillReport {
  const o = obj(input)
  const fields = Array.isArray(o.fields) ? o.fields.slice(0, 200).map(parseField) : []
  return { ats: oneOf(o.ats, ATS, 'generic'), url: httpUrl(o.url), fields, hasSubmitButton: o.hasSubmitButton === true }
}
