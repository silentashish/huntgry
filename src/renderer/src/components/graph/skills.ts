import type { KnowledgeGraph, SkillInfo } from '@shared/knowledge-graph'

/** How the Skills view orders its rows. */
export type SkillSort = 'jobs' | 'evidence' | 'years' | 'name'

/** Sort direction; numbers default to highest first, names to A–Z. */
export type SortDirection = 'asc' | 'desc'

/** Which skills the Skills view lists. */
export type SkillFilter = 'all' | 'gaps' | 'strong'

export const SKILL_SORT_LABEL: Record<SkillSort, string> = {
  jobs: 'Sort: jobs asking',
  evidence: 'Sort: evidence',
  years: 'Sort: years',
  name: 'Sort: name'
}

export function defaultDirection(sort: SkillSort): SortDirection {
  return sort === 'name' ? 'asc' : 'desc'
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

const kindsOf = (graph: KnowledgeGraph) => new Map<string, string>(graph.nodes.map((n) => [n.id, n.kind]))

/** Distinct roles and projects behind a skill, and whether the skills list names it. */
function evidenceSources(kinds: Map<string, string>, s: SkillInfo): { roles: number; projects: number; listed: boolean } {
  const roles = new Set<string>()
  const projects = new Set<string>()
  let listed = false
  for (const ev of s.evidence) {
    const kind = ev.nodeId ? kinds.get(ev.nodeId) : undefined
    if (kind === 'experience') roles.add(ev.nodeId!)
    else if (kind === 'project') projects.add(ev.nodeId!)
    else listed = true
  }
  return { roles: roles.size, projects: projects.size, listed }
}

/**
 * Sorts by `sort` in `direction` (its default when omitted). Evidence sorts by what the Evidence
 * column shows: distinct roles and projects, then a mention in the skills list. Ties fall back to
 * the other numbers, then to the name A–Z.
 */
export function sortSkills(
  graph: KnowledgeGraph,
  skills: readonly SkillInfo[],
  sort: SkillSort,
  direction: SortDirection = defaultDirection(sort)
): SkillInfo[] {
  const kinds = kindsOf(graph)
  const shown = (s: SkillInfo): number[] => {
    const src = evidenceSources(kinds, s)
    return [src.roles + src.projects, src.listed ? 1 : 0]
  }
  const key = (s: SkillInfo): Array<number | string> =>
    sort === 'jobs'
      ? [s.jobs.length, ...shown(s), s.years]
      : sort === 'evidence'
        ? [...shown(s), s.years, s.jobs.length]
        : sort === 'years'
          ? [s.years, ...shown(s), s.jobs.length]
          : [s.name.toLowerCase()]
  const sign = direction === 'asc' ? 1 : -1
  return [...skills].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue
      const cmp = typeof x[i] === 'string' ? String(x[i]).localeCompare(String(y[i])) : Number(x[i]) - Number(y[i])
      return sign * cmp
    }
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
  const { roles, projects, listed } = evidenceSources(kindsOf(graph), s)
  const parts: string[] = []
  if (roles) parts.push(plural(roles, 'role'))
  if (projects) parts.push(plural(projects, 'project'))
  if (listed && parts.length === 0) parts.push('skills list')
  return parts.join(' · ')
}

/** Years as a short readout: `7y`, `8.5y`, `–` when unknown. */
export function yearsLabel(years: number): string {
  return years > 0 ? `${years}y` : '–'
}
