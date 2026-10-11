import type { KnowledgeGraph, SkillInfo } from '@shared/knowledge-graph'

/** How the Skills view orders its rows. */
export type SkillSort = 'jobs' | 'evidence' | 'years' | 'name'

/** Which skills the Skills view lists. */
export type SkillFilter = 'all' | 'gaps' | 'strong'

export const SKILL_SORT_LABEL: Record<SkillSort, string> = {
  jobs: 'Sort: jobs asking',
  evidence: 'Sort: evidence',
  years: 'Sort: years',
  name: 'Sort: name'
}

/** A skill the profile backs well: three years or more, or three pieces of evidence. */
export function isStrong(s: SkillInfo): boolean {
  return !s.gap && (s.years >= 3 || s.evidence.length >= 3)
}

export function matchesFilter(s: SkillInfo, filter: SkillFilter): boolean {
  return filter === 'all' || (filter === 'gaps' ? s.gap : isStrong(s))
}

/** Matches the name or one of the skill's groups, case-insensitively. */
export function matchesQuery(s: SkillInfo, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || s.name.toLowerCase().includes(q) || s.categories.some((c) => c.toLowerCase().includes(q))
}

/** Highest first for the numbers (ties by name), A–Z for the name. */
export function sortSkills(skills: readonly SkillInfo[], sort: SkillSort): SkillInfo[] {
  const key = (s: SkillInfo): number[] =>
    sort === 'jobs'
      ? [s.jobs.length, s.evidence.length, s.years]
      : sort === 'evidence'
        ? [s.evidence.length, s.years, s.jobs.length]
        : sort === 'years'
          ? [s.years, s.evidence.length, s.jobs.length]
          : []
  return [...skills].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]
    return a.name.localeCompare(b.name)
  })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Where a skill's evidence comes from, e.g. `2 roles · 1 project` or `skills list`; `no evidence`
 * for a gap. Several highlights of one role count as one role.
 */
export function evidenceSummary(graph: KnowledgeGraph, s: SkillInfo): string {
  if (s.evidence.length === 0) return 'no evidence'
  const kinds = new Map(graph.nodes.map((n) => [n.id, n.kind]))
  const roles = new Set<string>()
  const projects = new Set<string>()
  let listed = false
  for (const ev of s.evidence) {
    const kind = ev.nodeId ? kinds.get(ev.nodeId) : undefined
    if (kind === 'experience') roles.add(ev.nodeId!)
    else if (kind === 'project') projects.add(ev.nodeId!)
    else listed = true
  }
  const parts: string[] = []
  if (roles.size) parts.push(plural(roles.size, 'role'))
  if (projects.size) parts.push(plural(projects.size, 'project'))
  if (listed && parts.length === 0) parts.push('skills list')
  return parts.join(' · ')
}

/** Years as a short readout: `7y`, `8.5y`, `–` when unknown. */
export function yearsLabel(years: number): string {
  return years > 0 ? `${years}y` : '–'
}
