import type { ApplicationRecord } from '@shared/applications-types'

/** Why Apply is not possible for an application yet, or `null` when it is (pure, unit-tested). */
export function applyBlocker(app: Pick<ApplicationRecord, 'files' | 'jobUrl'>): string | null {
  if (!app.files.includes('resume.pdf')) return 'No resume.pdf yet: build the resume in Tailor first.'
  if (!app.jobUrl) return 'No posting URL: add it in the application drawer first.'
  return null
}

export const APPLY_HINT = 'Apply: fill the application form in the in-app browser (you submit it yourself)'

/** "Already applied on 2026-09-30" (or without a date), for the duplicate-application question. */
export function alreadyAppliedText(appliedAt: string | undefined): string {
  return appliedAt
    ? `You marked this application as applied on ${appliedAt}.`
    : 'You marked this application as applied.'
}
