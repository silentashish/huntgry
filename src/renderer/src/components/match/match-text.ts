import type { ApplicationMatch } from '@shared/applications-types'

/**
 * The words of the re-score after tailoring (#151), worked out from `huntgry.json` → `match` alone so
 * the drawer, the Board card and Review say the same thing and it can be tested without rendering.
 */
export interface MatchText {
  /** "Profile fit 82 · Resume 74 (90% surfaced)". */
  line: string
  /** Hover text: what the numbers mean, and any failed must-have. */
  title: string
  /** "Left out: Kubernetes, Terraform" (the profile has them), or `null` when the resume shows all of them. */
  leftOut: string | null
}

export function matchText(m: ApplicationMatch): MatchText {
  const surfaced = m.surfaced === undefined ? '' : ` (${m.surfaced}% surfaced)`
  const title = [
    `Profile fit: how much of the job's ${m.requirements} requirement${m.requirements === 1 ? '' : 's'} your master profile has evidence for.`,
    'Resume: how much of them this resume shows. A resume only selects from the profile, so it cannot beat the fit.',
    ...(m.surfaced === undefined ? [] : ['Surfaced: the share of what the profile has that the resume shows.']),
    ...(m.gates ?? []).map((g) => `${g}: both scores are capped.`)
  ].join('\n')
  return {
    line: `Profile fit ${m.profileFit} · Resume ${m.resumeCoverage}${surfaced}`,
    title,
    leftOut: m.leftOut.length > 0 ? `Left out: ${m.leftOut.join(', ')}` : null
  }
}
