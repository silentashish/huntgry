import type { MasterProfile } from './master-profile'
import { displaySkill, mentions, mentionsAffirmatively, skillKey, splitSkills, TECH_VOCABULARY } from './skills'

/**
 * The person knowledge graph: what the master profile says the person did,
 * as nodes and edges, with the evidence behind every skill. Derived from the
 * profile on demand (pure, no storage); job descriptions can be overlaid to
 * show which skills postings ask for and which the profile lacks.
 */

export type NodeKind =
  'person' | 'experience' | 'company' | 'project' | 'skill' | 'education' | 'certification' | 'publication' | 'job'

/** Master profile editor tab that edits a node, for "edit in master profile" links. */
export type ProfileSection = 'contact' | 'summary' | 'experience' | 'projects' | 'education' | 'credentials' | 'notes'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  /** Secondary line, e.g. dates or the skill category. */
  detail: string
  section: ProfileSection | null
}

export type EdgeKind =
  'held_role' | 'worked_at' | 'used' | 'built' | 'studied_at' | 'certified' | 'published' | 'has_skill' | 'asks_for'

export interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
}

/** Where a skill shows up in the profile. */
export interface Evidence {
  /** Node the evidence belongs to (an experience or project), or `null` for the skills list. */
  nodeId: string | null
  /** e.g. `Senior Engineer · Orbital Data Labs` or `Skills: Languages`. */
  source: string
  /** Why it counts: `Technologies` or the highlight that mentions it. */
  text: string
}

export interface SkillInfo {
  id: string
  name: string
  /** Skill group(s) from the profile's skills section. */
  categories: string[]
  evidence: Evidence[]
  /** Years of use across experiences and projects (overlaps counted once), rounded to 0.5. */
  years: number
  /** Job ids (from the overlay) whose description mentions this skill. */
  jobs: string[]
  /** Only in job descriptions, not in the profile. */
  gap: boolean
}

export interface JobText {
  id: string
  title: string
  text: string
}

export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  skills: SkillInfo[]
}

const nodeId = (kind: NodeKind, key: string) => `${kind}:${key}`

/** Builds the graph for a profile, optionally overlaying job descriptions. */
export function buildKnowledgeGraph(
  profile: MasterProfile,
  jobs: readonly JobText[] = [],
  now = new Date()
): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const skills = new Map<string, SkillInfo & { intervals: [number, number][] }>()
  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n)
    return n.id
  }
  const addEdge = (source: string, target: string, kind: EdgeKind) => {
    if (!edges.some((e) => e.source === source && e.target === target && e.kind === kind))
      edges.push({ source, target, kind })
  }
  const skill = (name: string): SkillInfo & { intervals: [number, number][] } => {
    const key = skillKey(name)
    let s = skills.get(key)
    if (!s) {
      s = {
        id: nodeId('skill', key),
        name: displaySkill(name),
        categories: [],
        evidence: [],
        years: 0,
        jobs: [],
        gap: false,
        intervals: []
      }
      skills.set(key, s)
    }
    return s
  }

  const c = profile.contact
  const person = addNode({
    id: 'person',
    kind: 'person',
    label: c.name.trim() || 'You',
    detail: c.headline,
    section: 'contact'
  })

  // 1. Declared skills.
  for (const group of profile.skills) {
    for (const item of group.items) {
      if (!item.trim()) continue
      const s = skill(item)
      if (group.category && !s.categories.includes(group.category)) s.categories.push(group.category)
    }
  }

  // Technologies the profile's "Gaps & notes" says the person lacks: never evidence, always a gap.
  const gapText = profile.gaps.join('\n')
  const statedGaps = new Set(
    [...new Set([...profile.skills.flatMap((g) => g.items), ...TECH_VOCABULARY])]
      .filter((t) => mentions(gapText, t))
      .map(skillKey)
  )

  // Known technologies the profile writes about without listing them ("Built RAG pipelines")
  // are skills too; without this they would later show up as gaps.
  const profileText = [
    profile.summary,
    ...profile.experience.flatMap((e) => [e.project, ...e.highlights]),
    ...profile.projects.flatMap((p) => [p.description, ...p.highlights])
  ].join('\n')
  for (const tech of TECH_VOCABULARY) {
    if (!skills.has(skillKey(tech)) && !statedGaps.has(skillKey(tech)) && mentionsAffirmatively(profileText, tech))
      skill(tech)
  }

  // Vocabulary for finding mentions in free text: the profile's own skills first.
  const vocabulary = () => [...skills.values()].map((s) => s.name)

  // 2. Experience and projects: technologies fields, then mentions in highlights.
  const withEvidence = (
    ownerId: string,
    source: string,
    technologies: string,
    texts: string[],
    interval: [number, number] | null,
    edge: EdgeKind
  ) => {
    const found = new Map<string, Evidence>()
    for (const t of splitSkills(technologies)) {
      found.set(skillKey(t), { nodeId: ownerId, source, text: 'Technologies' })
      skill(t)
    }
    for (const name of vocabulary()) {
      const key = skillKey(name)
      if (found.has(key)) continue
      if (statedGaps.has(key)) continue
      const hit = texts.find((t) => mentionsAffirmatively(t, name))
      if (hit) found.set(key, { nodeId: ownerId, source, text: hit })
    }
    for (const [key, ev] of found) {
      const s = skills.get(key)!
      s.evidence.push(ev)
      if (interval) s.intervals.push(interval)
      addNode({ id: s.id, kind: 'skill', label: s.name, detail: s.categories.join(', '), section: 'summary' })
      addEdge(ownerId, s.id, edge)
    }
  }

  profile.experience.forEach((e, i) => {
    if (!e.company.trim() && !e.role.trim()) return
    const id = addNode({
      id: nodeId('experience', String(i)),
      kind: 'experience',
      label: e.role.trim() || e.company.trim(),
      detail: [e.company, dateRange(e.start, e.end)].filter(Boolean).join(' · '),
      section: 'experience'
    })
    addEdge(person, id, 'held_role')
    if (e.company.trim()) {
      const company = addNode({
        id: nodeId('company', e.company.trim().toLowerCase()),
        kind: 'company',
        label: e.company.trim(),
        detail: e.location,
        section: 'experience'
      })
      addEdge(id, company, 'worked_at')
    }
    const source = [e.role, e.company].filter((s) => s.trim()).join(' · ')
    withEvidence(
      id,
      source,
      e.technologies,
      [e.project, ...e.highlights].filter(Boolean),
      interval(e.start, e.end, now),
      'used'
    )
  })

  profile.projects.forEach((p, i) => {
    if (!p.name.trim()) return
    const id = addNode({
      id: nodeId('project', String(i)),
      kind: 'project',
      label: p.name.trim(),
      detail: p.dates,
      section: 'projects'
    })
    addEdge(person, id, 'built')
    const [start, end] = p.dates.split(RANGE_SEPARATOR)
    withEvidence(
      id,
      p.name.trim(),
      p.technologies,
      [p.description, ...p.highlights].filter(Boolean),
      start ? interval(start, end ?? start, now) : null,
      'used'
    )
  })

  profile.education.forEach((e, i) => {
    if (!e.institution.trim()) return
    const id = addNode({
      id: nodeId('education', String(i)),
      kind: 'education',
      label: e.institution.trim(),
      detail: [e.degree, e.field].filter(Boolean).join(', '),
      section: 'education'
    })
    addEdge(person, id, 'studied_at')
  })
  profile.certifications.forEach((cert, i) => {
    if (!cert.name.trim()) return
    const id = addNode({
      id: nodeId('certification', String(i)),
      kind: 'certification',
      label: cert.name.trim(),
      detail: [cert.issuer, cert.date].filter(Boolean).join(', '),
      section: 'credentials'
    })
    addEdge(person, id, 'certified')
  })
  profile.publications.forEach((pub, i) => {
    if (!pub.title.trim()) return
    const id = addNode({
      id: nodeId('publication', String(i)),
      kind: 'publication',
      label: pub.title.trim(),
      detail: [pub.venue, pub.date].filter(Boolean).join(', '),
      section: 'credentials'
    })
    addEdge(person, id, 'published')
  })

  // 3. Skills only in the skills list hang off the person, so every skill is reachable.
  for (const s of skills.values()) {
    if (!nodes.has(s.id)) {
      addNode({ id: s.id, kind: 'skill', label: s.name, detail: s.categories.join(', '), section: 'summary' })
      addEdge(person, s.id, 'has_skill')
    }
    for (const cat of s.categories)
      s.evidence.push({ nodeId: null, source: `Skills: ${cat}`, text: 'Listed in the skills section' })
    s.years = roundHalf(mergedYears(s.intervals))
  }

  // 4. Jobs: which skills each posting mentions; unknown technologies become gaps.
  const profileKeys = new Set(skills.keys())
  const lookFor = [...vocabulary(), ...TECH_VOCABULARY.filter((t) => !profileKeys.has(skillKey(t)))]
  for (const job of jobs) {
    const jid = addNode({
      id: nodeId('job', job.id),
      kind: 'job',
      label: job.title || job.id,
      detail: job.id,
      section: null
    })
    const seen = new Set<string>()
    for (const name of lookFor) {
      const key = skillKey(name)
      if (seen.has(key) || !mentions(job.text, name)) continue
      seen.add(key)
      const s = skill(name)
      if (!profileKeys.has(key) || statedGaps.has(key)) s.gap = true
      if (!s.jobs.includes(job.id)) s.jobs.push(job.id)
      addNode({
        id: s.id,
        kind: 'skill',
        label: s.name,
        detail: s.gap ? 'Asked for, not in your profile' : s.categories.join(', '),
        section: 'summary'
      })
      addEdge(jid, s.id, 'asks_for')
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    skills: [...skills.values()]
      .map(({ intervals: _intervals, ...s }) => s)
      .sort(
        (a, b) =>
          Number(a.gap) - Number(b.gap) ||
          b.evidence.length - a.evidence.length ||
          b.years - a.years ||
          a.name.localeCompare(b.name)
      )
  }
}

/**
 * Separates the two ends of a date range: a spaced hyphen ("2019 - 2022"), an
 * en/em dash or "to". An unspaced hyphen belongs to the date ("2022-03").
 */
const RANGE_SEPARATOR = /\s+-\s+|\s*[–—]\s*|\s+to\s+/i

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A date as a fractional year: `2022`, `Jan 2022`, `01/2022`, `2022-03`.
 * `Present`/`Current`/`Now` → `now`. `null` when there is no year.
 */
export function parseProfileDate(text: string, now = new Date(), end = false): number | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  if (/^(present|current|now|today|ongoing)$/.test(t)) return now.getFullYear() + now.getMonth() / 12
  const year = /(19|20)\d{2}/.exec(t)
  if (!year) return null
  const y = Number(year[0])
  const monthName = MONTHS.findIndex((m) => t.includes(m))
  const numeric = /(?:^|\D)(\d{1,2})[/-](?:19|20)\d{2}|(?:19|20)\d{2}[/-](\d{1,2})(?:\D|$)/.exec(t)
  const month = monthName >= 0 ? monthName : numeric ? Number(numeric[1] ?? numeric[2]) - 1 : null
  // A bare year counts from its start either way: "2019 – 2022" reads as three years.
  if (month === null || month < 0 || month > 11) return y
  return y + (month + (end ? 1 : 0)) / 12
}

function interval(start: string, end: string, now: Date): [number, number] | null {
  // "2022 - Present | Atlanta" style strings sometimes arrive in one field.
  const [s, e] = end.trim() ? [start, end] : start.split(RANGE_SEPARATOR)
  const a = parseProfileDate(s ?? '', now)
  const b = parseProfileDate((e ?? '').split('|')[0], now, true) ?? a
  if (a === null || b === null || b < a) return null
  // Something done within one year still took time.
  return [a, b === a ? a + 0.5 : b]
}

/** Total length of possibly overlapping intervals. */
export function mergedYears(intervals: readonly [number, number][]): number {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0])
  let total = 0
  let cur: [number, number] | null = null
  for (const [a, b] of sorted) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0]
      cur = [a, b]
    } else cur[1] = Math.max(cur[1], b)
  }
  if (cur) total += cur[1] - cur[0]
  return total
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2
}

function dateRange(start: string, end: string): string {
  return [start, end].filter((s) => s.trim()).join(' – ')
}
