/**
 * The master-profile update loop, pure part: which skills job descriptions keep
 * asking for that the profile lacks, and how confirmed evidence is written into
 * the profile. The user always confirms; nothing here invents experience.
 */

import type { GapInsight, GapJob, EvidenceUpdate } from './insights-types'
import { buildKnowledgeGraph, type JobText, type ProfileSection } from './knowledge-graph'
import type { MasterProfile } from './master-profile'
import { mentions, skillKey, splitSkills } from './skills'

/** A job description with where it came from. */
export interface SourcedJobText extends JobText {
  kind: GapJob['kind']
}

export interface GapSplit {
  /** Open gaps, most-asked first (ties by name). */
  gaps: GapInsight[]
  /** Gaps the profile's "Gaps & notes" already names. */
  noted: string[]
}

/**
 * Gaps from the knowledge graph over these job descriptions. Dismissed keys
 * and gaps the profile already acknowledges are left out of `gaps`.
 */
export function computeGaps(
  profile: MasterProfile,
  jobs: readonly SourcedJobText[],
  dismissed: ReadonlySet<string>,
  now = new Date()
): GapSplit {
  const graph = buildKnowledgeGraph(profile, jobs, now)
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const statedText = profile.gaps.join('\n')
  const gaps: GapInsight[] = []
  const noted: string[] = []
  for (const s of graph.skills) {
    if (!s.gap || s.jobs.length === 0) continue
    if (statedText && mentions(statedText, s.name)) {
      noted.push(s.name)
      continue
    }
    const key = skillKey(s.name)
    if (dismissed.has(key)) continue
    gaps.push({
      key,
      skill: s.name,
      jobs: s.jobs.map((id) => {
        const j = byId.get(id)
        return { id, title: j?.title || id, kind: j?.kind ?? 'application' }
      })
    })
  }
  gaps.sort((a, b) => b.jobs.length - a.jobs.length || a.skill.localeCompare(b.skill))
  return { gaps, noted: noted.sort((a, b) => a.localeCompare(b)) }
}

/** Sections with no content, in editor order, for "complete your profile" hints. */
export function emptySections(p: MasterProfile): ProfileSection[] {
  const out: ProfileSection[] = []
  const c = p.contact
  if (![c.name, c.email, c.headline].some((v) => v.trim())) out.push('contact')
  if (!p.summary.trim() && p.skills.every((g) => g.items.length === 0)) out.push('summary')
  if (p.experience.length === 0) out.push('experience')
  if (p.projects.length === 0) out.push('projects')
  if (p.education.length === 0) out.push('education')
  return out
}

/** Adds `skill` to a comma-separated technologies field unless it is already there (any spelling). */
function withTechnology(field: string, skill: string): string {
  const key = skillKey(skill)
  if (splitSkills(field).some((t) => skillKey(t) === key)) return field
  return field.trim() ? `${field.trim()}, ${skill}` : skill
}

/**
 * The profile with confirmed evidence for a skill added: a highlight and/or
 * the technology on an experience or project, or the skill in a skills group
 * (created when missing). Throws when the target does not exist.
 */
export function applyEvidence(profile: MasterProfile, update: EvidenceUpdate): MasterProfile {
  const skill = update.skill.trim()
  if (!skill) throw new Error('Name the skill.')
  const bullet = update.bullet?.trim() ?? ''
  const t = update.target
  if (t.kind === 'skills') {
    const category = t.category.trim() || 'Other'
    const key = skillKey(skill)
    const has = profile.skills.some((g) => g.items.some((i) => skillKey(i) === key))
    if (has) return profile
    const idx = profile.skills.findIndex((g) => g.category.trim().toLowerCase() === category.toLowerCase())
    const skills =
      idx === -1
        ? [...profile.skills, { category, items: [skill] }]
        : profile.skills.map((g, i) => (i === idx ? { ...g, items: [...g.items, skill] } : g))
    return { ...profile, skills }
  }
  if (!bullet && !update.addTechnology) throw new Error('Add a highlight or list it as a technology.')
  const list = t.kind === 'experience' ? profile.experience : profile.projects
  if (!Number.isInteger(t.index) || t.index < 0 || t.index >= list.length) {
    throw new Error(`That ${t.kind} is no longer in the profile. Reload and try again.`)
  }
  const edit = <E extends { technologies: string; highlights: string[] }>(e: E): E => ({
    ...e,
    technologies: update.addTechnology ? withTechnology(e.technologies, skill) : e.technologies,
    highlights: bullet && !e.highlights.includes(bullet) ? [...e.highlights, bullet] : e.highlights
  })
  return t.kind === 'experience'
    ? { ...profile, experience: profile.experience.map((e, i) => (i === t.index ? edit(e) : e)) }
    : { ...profile, projects: profile.projects.map((e, i) => (i === t.index ? edit(e) : e)) }
}

/**
 * Numbers in `text` that do not occur in `source`: in a drafted bullet they
 * were most likely made up, which the resume-tailor skill's honesty rule forbids.
 */
export function unsupportedNumbers(text: string, source: string): string[] {
  const nums = (s: string) => s.match(/\d+(?:[.,]\d+)*/g) ?? []
  const known = new Set(nums(source).map((n) => n.replace(/,/g, '')))
  return [...new Set(nums(text).filter((n) => !known.has(n.replace(/,/g, ''))))]
}
