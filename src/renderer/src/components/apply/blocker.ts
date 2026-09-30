import type { ApplicationRecord, ApplicationTracking } from '@shared/applications-types'
import { reviewBlocker } from '@shared/review-types'

/** Why Apply is not possible for an application yet, or `null` when it is (pure, unit-tested). */
export function applyBlocker(
  app: Pick<ApplicationRecord, 'files' | 'jobUrl'> & { tracking?: Pick<ApplicationTracking, 'review'> }
): string | null {
  // Same rule as ApplyService.open(): an unattended result stays out of Apply until it is approved (#31).
  const review = reviewBlocker(app.tracking?.review)
  if (review) return review
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

/**
 * The tracking to check before applying: the caller's when it has the record
 * (Dashboard), else read by id (a Tailor run knows only the folder), so
 * "Already applied" is asked from every entry point. Read directly rather
 * than searched in the list, which can be truncated in a large workspace.
 */
export async function trackingFor(
  target: { id: string; tracking?: ApplicationTracking },
  get: (id: string) => Promise<Pick<ApplicationRecord, 'tracking'>>
): Promise<ApplicationTracking> {
  if (target.tracking) return target.tracking
  return (await get(target.id)).tracking
}
