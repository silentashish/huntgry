/**
 * Types for the master-profile update loop: skills that job descriptions keep
 * asking for and the profile lacks, and the confirmed changes that close them.
 * Types and constants only.
 */

import type { ProfileSection } from './knowledge-graph'

export interface GapJob {
  /** Application folder (`role/company/job-id`) or saved job id (`hiring.cafe:…`). */
  id: string
  title: string
  kind: 'application' | 'saved'
}

/** A skill that job descriptions ask for and the master profile has no evidence of. */
export interface GapInsight {
  /** Normalized key (see `skillKey`); stable across spellings. */
  key: string
  /** Display name, e.g. `Kafka`. */
  skill: string
  jobs: GapJob[]
}

export interface DismissedGap {
  key: string
  skill: string
  /** ISO timestamp. */
  at: string
}

export interface ProfileInsights {
  /** Open gaps, most-asked first. */
  gaps: GapInsight[]
  /** Gaps the user said they do not have ("Not me"). */
  dismissed: DismissedGap[]
  /** Gaps the profile's "Gaps & notes" already acknowledges; not offered for an update. */
  noted: string[]
  /** Job descriptions the gaps were computed from. */
  jobCount: number
  profile: {
    /** Last modification of `master-profile.md` (ISO), or `null` if unknown. */
    updatedAt: string | null
    /** Sections with nothing in them, for completeness hints. */
    emptySections: ProfileSection[]
  }
}

/** Where confirmed evidence for a skill goes in the master profile. */
export type EvidenceTarget =
  | { kind: 'experience'; index: number }
  | { kind: 'project'; index: number }
  | { kind: 'skills'; category: string }

export interface EvidenceUpdate {
  skill: string
  target: EvidenceTarget
  /** Highlight to add to the experience or project (ignored for `skills`). */
  bullet?: string
  /** Also list the skill in the entry's technologies. Always true for `skills`. */
  addTechnology: boolean
}

/** What the user tells Claude so it can word a bullet; Claude only rephrases this. */
export interface DraftRequest {
  skill: string
  target: EvidenceTarget
  notes: string
}

export interface EvidenceDraft {
  bullet: string
  /** Numbers in the bullet that do not appear in the user's notes: likely invented. */
  unsupportedNumbers: string[]
  costUsd: number
}

export interface InsightsApi {
  get(): Promise<ProfileInsights>
  /** "Not me": hide the gap until restored. */
  dismiss(key: string, skill: string): Promise<ProfileInsights>
  restore(key: string): Promise<ProfileInsights>
  /** Ask Claude (no tools, no network) to word a bullet from the user's own notes. Writes nothing. */
  draft(request: DraftRequest): Promise<EvidenceDraft>
}

export const INSIGHTS_CHANNELS = {
  get: 'insights:get',
  dismiss: 'insights:dismiss',
  restore: 'insights:restore',
  draft: 'insights:draft'
} as const
