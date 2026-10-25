import { evidenceMatcher, matchScore, GATE_CAP, type MatchGate, type MatchJob, type MatchProfile, type MatchSkill, type MatchSource } from './match-score'
import { splitSkills } from './skills'

/**
 * Re-score after tailoring (#151): how much of a job a tailored resume shows, next to how much the master
 * profile could have shown. The skill's honesty rule lets a resume select from the profile, never add to it,
 * so the resume's coverage can't beat the profile's: "the score went up" can only mean the resume surfaced
 * more of what the profile has.
 *
 * - **Profile fit**: `matchScore(job, profile).score` (#149), the ceiling.
 * - **Resume coverage**: the same requirements, with the same weights and gates, matched against the
 *   resume's words instead of the profile's.
 * - **Surfaced**: the share of what the profile matched that the resume shows, by weight, at most 100.
 *
 * Local and deterministic, like the match score. The benchmark (#152) calls `resumeCoverage` too.
 */

/** A tailored resume's words, from its `resume_data.json` (`resumeEvidenceFromData`) or its PDF's text. */
export interface ResumeEvidence {
  /** The skills rows' names ("Languages: Python, Go" → `Python`, `Go`); empty when only text is known. */
  skills: string[]
  /** Everything the resume says: summary, roles and bullets, projects, education, certifications, skills. */
  text: string
}

export interface ResumeCoverage {
  /** 0–100: the job's match score against the master profile (`matchScore`), gates applied. */
  profileFit: number
  /** 0–100: the same requirements matched against the resume, by weight; capped at `GATE_CAP` like the fit. */
  resumeCoverage: number
  /**
   * 0–100: weight of the requirements both the profile and the resume have ÷ weight of those the profile has.
   * `null` when the profile has none of them (nothing to surface). Never above 100.
   */
  surfaced: number | null
  /** How many requirements the job names. */
  requirements: number
  /** Requirements the profile has and the resume leaves out, heaviest first: what a re-run could add. */
  leftOut: MatchSkill[]
  /** Requirements the resume shows, heaviest first. */
  shown: MatchSkill[]
  /**
   * Requirements the resume shows that the profile has no evidence for. Empty under the honesty rule; when not,
   * the profile's wording missed a synonym the resume used, or the resume claims something to check.
   */
  unbacked: MatchSkill[]
  /** Requirements neither has, heaviest first. */
  missing: MatchSkill[]
  /** The job's failed must-haves against the profile; they cap both numbers. */
  gates: MatchGate[]
  source: MatchSource
}

const heaviest = (a: MatchSkill, b: MatchSkill) => b.weight - a.weight || a.skill.localeCompare(b.skill)
const weight = (xs: readonly MatchSkill[]) => xs.reduce((n, r) => n + r.weight, 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

/**
 * The words of the skill's `resume_data.json` (its `ResumeData` schema): skills rows, summary, roles with their
 * bullets, projects with their tech, education, certifications, publications. Contact details are left out.
 * `null` when it is not an object with any of those.
 */
export function resumeEvidenceFromData(data: unknown): ResumeEvidence | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const rows = list(d.skills).map(rec)
  const skills = [...new Set(rows.flatMap((r) => splitSkills(str(r.items))))]
  const text = [
    ...rows.map((r) => [str(r.label), str(r.items)].filter(Boolean).join(': ')),
    str(d.summary),
    ...list(d.experience)
      .map(rec)
      .flatMap((e) => [str(e.title), str(e.project_name), ...list(e.bullets).map(str)]),
    ...list(d.projects)
      .map(rec)
      .flatMap((p) => [str(p.name), str(p.tech), ...list(p.bullets).map(str)]),
    ...list(d.education)
      .map(rec)
      .flatMap((e) => [str(e.degree), str(e.detail)]),
    ...list(d.certifications).map((c) => str(rec(c).name)),
    ...list(d.publications).map((p) => str(rec(p).title))
  ]
    .filter((t) => t.trim())
    .join('\n')
  return text ? { skills, text } : null
}

/** A resume known only by its text (the PDF's): matched on its words alone. */
export function resumeEvidenceFromText(text: string): ResumeEvidence | null {
  return text.trim() ? { skills: [], text } : null
}

/**
 * Profile fit, resume coverage and how much of the fit the resume surfaced, for one job: the numbers the
 * application drawer, Board card and Review show after a tailoring run, and the benchmark (#152) compares.
 *
 * The requirements are `matchScore(job, profile)`'s, so a description-only job is read with the profile's
 * skills as the vocabulary for both numbers. `null` when the job names no requirement (nothing to compare).
 *
 * @example
 * const r = resumeCoverage(job, profileSignals(profile), resumeEvidenceFromData(resumeData)!)
 * // { profileFit: 82, resumeCoverage: 74, surfaced: 90, leftOut: [{ skill: 'Kafka', … }], … }
 */
export function resumeCoverage(job: MatchJob, profile: MatchProfile, resume: ResumeEvidence): ResumeCoverage | null {
  const fit = matchScore(job, profile)
  const all = [...fit.matched, ...fit.missing]
  if (all.length === 0) return null
  const onResume = evidenceMatcher({ skills: resume.skills, evidence: resume.text })
  const backed = new Set(fit.matched)
  const shown = all.filter((r) => onResume(r.skill)).sort(heaviest)
  const leftOut = fit.matched.filter((r) => !shown.includes(r))
  const surfacedWeight = weight(shown.filter((r) => backed.has(r)))
  const backedWeight = weight(fit.matched)
  const coverage = Math.round((weight(shown) / weight(all)) * 100)
  return {
    profileFit: fit.score,
    resumeCoverage: fit.gates.length > 0 ? Math.min(coverage, GATE_CAP) : coverage,
    // Both sides are the same requirements' weights, so it can't pass 100; clamped anyway.
    surfaced: backedWeight > 0 ? Math.min(100, Math.round((surfacedWeight / backedWeight) * 100)) : null,
    requirements: all.length,
    leftOut,
    shown,
    unbacked: shown.filter((r) => !backed.has(r)),
    missing: fit.missing.filter((r) => !shown.includes(r)),
    gates: fit.gates,
    source: fit.source
  }
}
