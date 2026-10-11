import { describe, expect, it } from 'vitest'
import type { KnowledgeGraph, SkillInfo } from '@shared/knowledge-graph'
import { GAP_COLOR, KIND_COLOR, parseColor, tokenName, withAlpha } from './colors'
import { evidenceSummary, isStrong, matchesFilter, matchesQuery, sortSkills, yearsLabel } from './skills'

describe('graph colours', () => {
  it('are Scent Trail tokens only, one per node kind', () => {
    for (const color of [...Object.values(KIND_COLOR), GAP_COLOR]) expect(color).toMatch(/^var\(--hg-[\w-]+\)$/)
    // Company and Project stay apart.
    expect(KIND_COLOR.company).not.toBe(KIND_COLOR.project)
    expect(tokenName('var(--hg-status-info)')).toBe('--hg-status-info')
    expect(tokenName('--hg-x')).toBe('--hg-x')
  })

  it('parses the forms the tokens use and applies alpha for the canvas', () => {
    expect(parseColor('#3470e0')).toEqual({ r: 52, g: 112, b: 224, a: 1 })
    expect(parseColor(' #fff ')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('rgb(11 15 21 / 6%)')).toEqual({ r: 11, g: 15, b: 21, a: 0.06 })
    expect(parseColor('rgba(255, 138, 31, 0.45)')).toEqual({ r: 255, g: 138, b: 31, a: 0.45 })
    expect(parseColor('var(--x)')).toBeNull()
    expect(withAlpha('#3470e0', 0.2)).toBe('rgba(52, 112, 224, 0.2)')
    expect(withAlpha('rgb(0 0 0 / 50%)', 0.5)).toBe('rgba(0, 0, 0, 0.25)')
    expect(withAlpha('papayawhip', 0.5)).toBe('papayawhip')
  })
})

const skill = (over: Partial<SkillInfo>): SkillInfo => ({
  id: `skill:${over.name}`,
  name: 'X',
  categories: [],
  evidence: [],
  years: 0,
  jobs: [],
  gap: false,
  ...over
})

describe('skills view helpers', () => {
  const go = skill({
    name: 'Go',
    categories: ['Languages'],
    years: 4,
    jobs: ['a', 'b'],
    evidence: [
      { nodeId: 'exp:0', source: 'Engineer · Acme', text: 'Technologies' },
      { nodeId: 'exp:0', source: 'Engineer · Acme', text: 'Built it in Go' },
      { nodeId: 'proj:0', source: 'tiny-queue', text: 'Technologies' }
    ]
  })
  const kafka = skill({ name: 'Kafka', gap: true, jobs: ['a', 'b', 'c'] })
  const sql = skill({ name: 'SQL', categories: ['Data'], evidence: [{ nodeId: null, source: 'Skills: Data', text: 'Listed' }] })
  const graph: KnowledgeGraph = {
    nodes: [
      { id: 'exp:0', kind: 'experience', label: 'Engineer', detail: '', section: 'experience' },
      { id: 'proj:0', kind: 'project', label: 'tiny-queue', detail: '', section: 'projects' }
    ],
    edges: [],
    skills: [go, kafka, sql]
  }

  it('summarises evidence by role and project, one role however many highlights', () => {
    expect(evidenceSummary(graph, go)).toBe('1 role · 1 project')
    expect(evidenceSummary(graph, sql)).toBe('skills list')
    expect(evidenceSummary(graph, kafka)).toBe('no evidence')
  })

  it('filters by name or group, and by gaps or strong skills', () => {
    expect(matchesQuery(go, 'lang')).toBe(true)
    expect(matchesQuery(go, 'data')).toBe(false)
    expect(matchesQuery(sql, ' DATA ')).toBe(true)
    expect(isStrong(go)).toBe(true)
    expect(isStrong(sql)).toBe(false)
    expect(isStrong(kafka)).toBe(false)
    expect([go, kafka, sql].filter((s) => matchesFilter(s, 'gaps')).map((s) => s.name)).toEqual(['Kafka'])
    expect([go, kafka, sql].filter((s) => matchesFilter(s, 'all'))).toHaveLength(3)
  })

  it('sorts by jobs asking, evidence, years or name', () => {
    expect(sortSkills([go, kafka, sql], 'jobs').map((s) => s.name)).toEqual(['Kafka', 'Go', 'SQL'])
    expect(sortSkills([go, kafka, sql], 'evidence').map((s) => s.name)).toEqual(['Go', 'SQL', 'Kafka'])
    expect(sortSkills([sql, kafka, go], 'years').map((s) => s.name)).toEqual(['Go', 'SQL', 'Kafka'])
    expect(sortSkills([sql, kafka, go], 'name').map((s) => s.name)).toEqual(['Go', 'Kafka', 'SQL'])
    expect(yearsLabel(8.5)).toBe('8.5y')
    expect(yearsLabel(0)).toBe('–')
  })
})
