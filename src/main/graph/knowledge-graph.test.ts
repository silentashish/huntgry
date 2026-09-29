import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMasterProfile } from '../profile/format'
import { buildKnowledgeGraph, mergedYears, parseProfileDate } from '@shared/knowledge-graph'
import { emptyProfile, type MasterProfile } from '@shared/master-profile'
import { displaySkill, mentions, mentionsAffirmatively, skillKey, splitSkills } from '@shared/skills'

const NOW = new Date(2026, 8, 29)

function profile(): MasterProfile {
  const p = emptyProfile()
  p.contact.name = 'Jordan Rivera'
  p.skills = [
    { category: 'Languages', items: ['Python', 'TypeScript', 'Go'] },
    { category: 'Infrastructure', items: ['k8s', 'Postgres', 'Terraform'] }
  ]
  p.experience = [
    {
      company: 'Orbital',
      role: 'Senior Engineer',
      start: 'Jan 2022',
      end: 'Present',
      location: 'Atlanta',
      employmentType: '',
      project: '',
      projectLink: '',
      technologies: 'Python, Kubernetes, Airflow',
      highlights: [
        'Migrated batch jobs to Airflow on AWS',
        'Tuned PostgreSQL queries for the API',
        'Helped the team go live faster'
      ]
    },
    {
      company: 'Brightcart',
      role: 'Engineer',
      start: '2019',
      end: '2022',
      location: '',
      employmentType: '',
      project: '',
      projectLink: '',
      technologies: 'Node.js; TypeScript',
      highlights: ['Moved checkout from PHP to Node']
    }
  ]
  p.projects = [
    { name: 'Tracegrep', link: '', dates: '2023', technologies: 'Go', description: 'Trace search CLI', highlights: [] }
  ]
  p.education = [
    {
      institution: 'Georgia Tech',
      degree: 'M.S.',
      field: 'CS',
      start: '',
      end: '2019',
      location: '',
      gpa: '',
      highlights: []
    }
  ]
  return p
}

describe('skill names', () => {
  it('normalizes aliases to one key and a canonical display name', () => {
    expect(skillKey('k8s')).toBe(skillKey('Kubernetes'))
    expect(skillKey('Postgres')).toBe(skillKey('PostgreSQL'))
    expect(skillKey('JS')).toBe(skillKey('javascript'))
    expect(skillKey('Node')).toBe(skillKey('node.js'))
    expect(displaySkill('golang')).toBe('Go')
    expect(displaySkill('  Some   Tool ')).toBe('Some Tool')
  })

  it('splits technology fields but keeps names with a slash', () => {
    expect(splitSkills('Python, Go / Kafka; AWS (EKS) and Docker')).toEqual(['Python', 'Go', 'Kafka', 'AWS', 'Docker'])
    expect(splitSkills('CI/CD, Python / ci/cd, UI/UX')).toEqual(['CI/CD', 'Python', 'ci/cd', 'UI/UX'])
    expect(splitSkills('AWS (EKS/EC2), Go (1.22, generics)')).toEqual(['AWS', 'Go'])
  })

  it('matches three-letter names in any case, but ordinary-word names only as written', () => {
    expect(mentions('experience with aws and sql', 'AWS')).toBe(true)
    expect(mentions('experience with aws and sql', 'SQL')).toBe(true)
    expect(mentions('a ray of hope', 'Ray')).toBe(false)
    expect(mentions('distributed training on Ray', 'Ray')).toBe(true)
    expect(mentionsAffirmatively('No production Rust experience. Some Go.', 'Rust')).toBe(false)
    expect(mentionsAffirmatively('Wrote Rust services.', 'Rust')).toBe(true)
    // A negation only covers the skill it describes.
    expect(mentionsAffirmatively('Used Python but not Rust.', 'Python')).toBe(true)
    expect(mentionsAffirmatively('Used Python but not Rust.', 'Rust')).toBe(false)
    expect(mentionsAffirmatively('No Kafka; built the pipeline in Airflow.', 'Airflow')).toBe(true)
    expect(mentionsAffirmatively('Rust at work, no Rust at home', 'Rust')).toBe(true)
  })

  it('finds mentions without matching ordinary words or longer names', () => {
    expect(mentions('Built services in Go and Rust', 'Go')).toBe(true)
    expect(mentions('Helped the team go live', 'Go')).toBe(false)
    expect(mentions('Strong C++ and C# skills', 'C++')).toBe(true)
    expect(mentions('Deployed to k8s clusters', 'Kubernetes')).toBe(true)
    expect(mentions('We use JavaScript', 'Java')).toBe(false)
    expect(mentions('Node.js services', 'Node.js')).toBe(true)
    expect(mentions('ReactNative', 'React')).toBe(false)
  })
})

describe('dates', () => {
  it('parses profile dates as fractional years', () => {
    expect(parseProfileDate('2022', NOW)).toBe(2022)
    expect(parseProfileDate('2022', NOW, true)).toBe(2022)
    expect(parseProfileDate('Mar 2022', NOW, true)).toBeCloseTo(2022 + 3 / 12)
    expect(parseProfileDate('Mar 2022', NOW)).toBeCloseTo(2022 + 2 / 12)
    expect(parseProfileDate('03/2022', NOW)).toBeCloseTo(2022 + 2 / 12)
    expect(parseProfileDate('Present', NOW)).toBeCloseTo(2026 + 8 / 12)
    expect(parseProfileDate('someday', NOW)).toBeNull()
  })

  it('counts overlapping intervals once', () => {
    expect(
      mergedYears([
        [2019, 2022],
        [2021, 2023],
        [2025, 2026]
      ])
    ).toBe(5)
  })
})

describe('buildKnowledgeGraph', () => {
  it('links roles, companies, projects and skills with evidence and years', () => {
    const g = buildKnowledgeGraph(profile(), [], NOW)
    const ids = new Set(g.nodes.map((n) => n.id))
    expect(ids).toContain('person')
    expect(ids).toContain('experience:0')
    expect(ids).toContain('company:orbital')
    expect(ids).toContain('project:0')
    expect(ids).toContain('education:0')

    const byName = Object.fromEntries(g.skills.map((s) => [s.name, s]))
    // k8s in the skills list and Kubernetes in technologies are one skill.
    expect(byName.Kubernetes.categories).toEqual(['Infrastructure'])
    expect(byName.Kubernetes.evidence.map((e) => e.nodeId)).toEqual(['experience:0', null])
    // PostgreSQL comes from a highlight mention, not a technologies field.
    expect(byName.PostgreSQL.evidence[0]).toMatchObject({
      nodeId: 'experience:0',
      text: 'Tuned PostgreSQL queries for the API'
    })
    // "go live" is not Go; Go comes from the project only.
    expect(byName.Go.evidence.map((e) => e.nodeId)).toEqual(['project:0', null])
    // TypeScript: Brightcart 2019–2022 (3 years).
    expect(byName.TypeScript.years).toBe(3)
    // Python: Orbital Jan 2022 – Sep 2026 (4.7 years, to the nearest half).
    expect(byName.Python.years).toBe(4.5)
    // Terraform is only listed: it hangs off the person.
    expect(g.edges).toContainEqual({ source: 'person', target: byName.Terraform.id, kind: 'has_skill' })
    expect(g.edges).toContainEqual({ source: 'experience:0', target: 'company:orbital', kind: 'worked_at' })
    // Every edge points at existing nodes.
    for (const e of g.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true)
    }
  })

  it('overlays jobs: hits on profile skills, gaps for technologies the profile lacks', () => {
    const g = buildKnowledgeGraph(
      profile(),
      [
        {
          id: 'backend/acme/1',
          title: 'Backend Engineer',
          text: 'Python, Kubernetes (k8s), Kafka and Terraform. Go is a plus.'
        },
        { id: 'sre/globex/2', title: 'SRE', text: 'Kafka, Prometheus and on-call.' }
      ],
      NOW
    )
    const byName = Object.fromEntries(g.skills.map((s) => [s.name, s]))
    expect(byName.Python.jobs).toEqual(['backend/acme/1'])
    expect(byName.Python.gap).toBe(false)
    expect(byName.Kafka).toMatchObject({ gap: true, jobs: ['backend/acme/1', 'sre/globex/2'] })
    expect(byName.Prometheus.gap).toBe(true)
    expect(g.nodes.find((n) => n.id === 'job:sre/globex/2')?.kind).toBe('job')
    expect(g.edges).toContainEqual({ source: 'job:backend/acme/1', target: byName.Kafka.id, kind: 'asks_for' })
    // Airflow is only in a technologies field and a highlight, never in the skills list: still not a gap.
    expect(byName.Airflow.gap).toBe(false)
    // Gaps sort after the person's own skills.
    const firstGap = g.skills.findIndex((s) => s.gap)
    expect(g.skills.slice(firstGap).every((s) => s.gap)).toBe(true)
  })

  it('does not report a technology the profile writes about as a gap', () => {
    const p = profile()
    p.experience[0].highlights.push('Built RAG pipelines with LangGraph')
    const g = buildKnowledgeGraph(p, [{ id: 'ml/co/1', title: 'ML', text: 'Experience with RAG and Kafka.' }], NOW)
    const byName = Object.fromEntries(g.skills.map((s) => [s.name, s]))
    expect(byName.RAG).toMatchObject({ gap: false, jobs: ['ml/co/1'] })
    expect(byName.RAG.evidence[0]).toMatchObject({ nodeId: 'experience:0', text: 'Built RAG pipelines with LangGraph' })
    expect(byName.Kafka.gap).toBe(true)
  })

  it('keeps negated mentions and stated gaps out of the skills', () => {
    const p = profile()
    p.summary = 'Backend engineer. No production Rust experience yet.'
    p.gaps = ['Kafka: never used it in production']
    p.experience[0].highlights.push('Evaluated Kafka but shipped without it')
    const g = buildKnowledgeGraph(p, [{ id: 'j/1', title: 'J', text: 'Rust and Kafka required.' }], NOW)
    const byName = Object.fromEntries(g.skills.map((s) => [s.name, s]))
    expect(byName.Rust).toMatchObject({ gap: true, evidence: [] })
    expect(byName.Kafka).toMatchObject({ gap: true, evidence: [] })
  })

  it('keeps ISO dates whole when computing project years', () => {
    const p = profile()
    p.projects = [
      { name: 'Tool', link: '', dates: '2022-03 – 2024-03', technologies: 'Rust', description: '', highlights: [] }
    ]
    const byName = Object.fromEntries(buildKnowledgeGraph(p, [], NOW).skills.map((s) => [s.name, s]))
    expect(byName.Rust.years).toBe(2)
  })

  it('handles an empty profile', () => {
    const g = buildKnowledgeGraph(emptyProfile(), [], NOW)
    expect(g.nodes).toEqual([{ id: 'person', kind: 'person', label: 'You', detail: '', section: 'contact' }])
    expect(g.skills).toEqual([])
  })

  it("builds a navigable graph from the skill's example master profile", () => {
    const md = readFileSync(join(__dirname, 'fixtures/master_profile.example.md'), 'utf8')
    const { profile: p } = parseMasterProfile(md)
    const g = buildKnowledgeGraph(p, [], NOW)
    expect(g.nodes.filter((n) => n.kind === 'experience').length).toBe(p.experience.length)
    expect(g.skills.length).toBeGreaterThan(5)
    expect(g.skills.some((s) => s.evidence.some((e) => e.nodeId?.startsWith('experience:')))).toBe(true)
    const ids = new Set(g.nodes.map((n) => n.id))
    expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true)
  })
})
