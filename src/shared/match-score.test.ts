import { describe, expect, it } from 'vitest'
import { profileSignals, scoreJob, type ProfileSignals } from './job-relevance'
import type { Job } from './jobs-types'
import { emptyEducation, emptyExperience, emptyProfile, type MasterProfile } from './master-profile'
import { GATE_CAP, matchScore, minimumYears, type JobrightSkill, type MatchJob, type MatchProfile } from './match-score'

const NOW = new Date('2026-10-24T12:00:00Z')

const profile = (over: Partial<MatchProfile> = {}): MatchProfile => ({
  skills: ['Python', 'Go', 'PostgreSQL', 'AWS', 'Docker'],
  years: 4,
  needsSponsorship: false,
  degrees: [{ degree: 'Master of Science', field: 'Computer Science' }],
  evidence: '',
  ...over
})

const job = (description: string, over: Partial<MatchJob> = {}): MatchJob => ({ title: 'Software Engineer', description, ...over })

const names = (xs: { skill: string }[]) => xs.map((x) => x.skill)

describe('matchScore', () => {
  describe('synonyms', () => {
    it('normalizes JS/JavaScript, Postgres/PostgreSQL and k8s/Kubernetes, both ways', () => {
      const s = profile({ skills: ['JS', 'Postgres', 'k8s'] })
      const r = matchScore(job('We use JavaScript, PostgreSQL and Kubernetes.'), s)
      expect(r).toMatchObject({ score: 100, source: 'description', missing: [], gates: [] })
      expect(names(r.matched).sort()).toEqual(['JavaScript', 'Kubernetes', 'PostgreSQL'])

      const back = matchScore(job('Postgres, k8s and Javascript.'), profile({ skills: ['JavaScript', 'PostgreSQL', 'Kubernetes'] }))
      expect(back.score).toBe(100)
      expect(names(back.matched).sort()).toEqual(['JavaScript', 'Kubernetes', 'PostgreSQL'])
    })

    it('matches Jobright names with filler words, parentheses and aliases to the profile', () => {
      const core: JobrightSkill[] = [
        { skill: 'Python Programming', score: 3, type: 'hard_skill' },
        { skill: 'Amazon Web Services (AWS)', score: 2, type: 'hard_skill' },
        { skill: 'JS', score: 1, type: 'hard_skill' },
        { skill: 'k8s', score: 1, type: 'hard_skill' }
      ]
      const r = matchScore(job('', { jdCoreSkills: core }), profile({ skills: ['Python', 'AWS', 'JavaScript'] }))
      expect(names(r.matched)).toEqual(['Python Programming', 'Amazon Web Services (AWS)', 'JavaScript'])
      expect(names(r.missing)).toEqual(['Kubernetes'])
      expect(r.score).toBe(Math.round((6 / 7) * 100))
    })

    it('keeps compound slash names whole: CD is not CI/CD, IP is not TCP/IP, but React/Vue is either', () => {
      const core = (skill: string): MatchJob => job('', { jdCoreSkills: [{ skill, score: 3, type: 'hard_skill' }] })
      expect(matchScore(core('TCP/IP'), profile({ skills: ['IP'] })).score).toBe(0)
      expect(matchScore(core('CI/CD'), profile({ skills: ['CD'] })).score).toBe(0)
      expect(matchScore(core('I/O'), profile({ skills: ['IO'] })).score).toBe(0)
      expect(matchScore(core('CI/CD'), profile({ skills: ['CI/CD'] })).score).toBe(100)
      expect(matchScore(core('TCP/IP'), profile({ skills: [], evidence: 'Debugged TCP/IP stacks.' })).score).toBe(100)
      expect(matchScore(core('React/Vue'), profile({ skills: ['Vue'] })).score).toBe(100)
    })

    it('does not confuse Java with JavaScript', () => {
      const r = matchScore(job('Strong Java and Spring Boot.'), profile({ skills: ['JavaScript'] }))
      expect(names(r.matched)).toEqual([])
      expect(names(r.missing)).toContain('Java')
    })
  })

  describe('weights', () => {
    it('weighs Jobright skills by their score, soft skills at 0.3', () => {
      const core: JobrightSkill[] = [
        { skill: 'Python', score: 3, type: 'hard_skill' },
        { skill: 'Kafka', score: 1, type: 'hard_skill' },
        { skill: 'Communication', score: 3, type: 'soft_skill' }
      ]
      const r = matchScore(job('', { jdCoreSkills: core }), profile())
      // 3 of 3 + 1 + 0.9.
      expect(r.score).toBe(Math.round((3 / 4.9) * 100))
      expect(r.missing).toEqual([
        { skill: 'Kafka', weight: 1, soft: false },
        { skill: 'Communication', weight: 0.9, soft: true }
      ])
    })

    it('weighs a skill named only as preferred at half', () => {
      const text = ['Requirements:', '- Python and Go', '- PostgreSQL', '', 'Nice to have:', '- Rust', '- Kafka'].join('\n')
      const r = matchScore(job(text), profile())
      expect(r.missing).toEqual([
        { skill: 'Kafka', weight: 0.5, soft: false },
        { skill: 'Rust', weight: 0.5, soft: false }
      ])
      expect(r.score).toBe(75)
      // A sentence that says so is a preference too, outside any section.
      expect(matchScore(job('You will write Python. Experience with Kafka is a plus.'), profile()).score).toBe(67)
    })

    it('counts a skill named as required anywhere at full weight', () => {
      const r = matchScore(job('Requirements:\n- Kafka\n\nPreferred:\n- Kafka Streams in production'), profile())
      expect(r.missing).toEqual([{ skill: 'Kafka', weight: 1, soft: false }])
    })

    it('counts technologies the profile lacks against it (description source)', () => {
      const r = matchScore(job('Build services in Go on Kafka, deployed with Terraform.'), profile())
      expect(names(r.matched)).toEqual(['Go'])
      expect(names(r.missing)).toEqual(['Kafka', 'Terraform'])
      expect(r.score).toBe(33)
    })

    it('reads tags and the title as requirements', () => {
      const r = matchScore(job('', { title: 'Python Engineer', tags: ['Redis'] }), profile())
      expect(names(r.matched)).toEqual(['Python'])
      expect(names(r.missing)).toEqual(['Redis'])
    })
  })

  describe('evidence', () => {
    it('takes evidence from the profile words, not only skill names, but never a negated mention', () => {
      const s = profile({ skills: ['Python'], evidence: 'AWS (EC2, S3, Lambda)\nLed data analysis for the lab.\nNo production Rust.' })
      const core: JobrightSkill[] = [
        { skill: 'Data Analysis', score: 2, type: 'hard_skill' },
        { skill: 'S3', score: 1, type: 'hard_skill' },
        { skill: 'Rust', score: 1, type: 'hard_skill' }
      ]
      const r = matchScore(job('', { jdCoreSkills: core }), s)
      expect(names(r.matched)).toEqual(['Data Analysis', 'S3'])
      expect(names(r.missing)).toEqual(['Rust'])
    })

    it('scores 0 with nothing matched or missing when the job names no requirement', () => {
      expect(matchScore(job('A great place to work.'), profile())).toEqual({
        score: 0,
        matched: [],
        missing: [],
        gates: [],
        source: 'description'
      })
    })
  })

  describe('live Jobright jdCoreSkills shape', () => {
    // As read from a signed-in posting page's __NEXT_DATA__ (dataSource.jobResult.jdCoreSkills).
    const live = JSON.parse(
      '[{"skill":"Data Analysis","score":3,"type":"hard_skill"},{"skill":"Python","score":3,"type":"hard_skill"},' +
        '{"skill":"SQL","score":2,"type":"hard_skill"},{"skill":"Tableau","score":1,"type":"hard_skill"},' +
        '{"skill":"Communication","score":2,"type":"soft_skill"},{"skill":"Problem Solving","score":1,"type":"soft_skill"}]'
    ) as JobrightSkill[]

    it('prefers jdCoreSkills over the description', () => {
      const r = matchScore(job('Kafka, Terraform, Rust, Scala everywhere.', { jdCoreSkills: live }), profile({ skills: ['Python', 'SQL'] }))
      expect(r.source).toBe('jobright-skills')
      expect(names(r.matched)).toEqual(['Python', 'SQL'])
      expect(names(r.missing)).toEqual(['Data Analysis', 'Tableau', 'Communication', 'Problem Solving'])
      // (3 + 2) / (3 + 3 + 2 + 1 + 0.6 + 0.3)
      expect(r.score).toBe(Math.round((5 / 9.9) * 100))
    })

    it('falls back to the description when jdCoreSkills is empty or malformed', () => {
      const junk = [{ skill: '', score: 3, type: 'hard_skill' }, { score: 2 }] as unknown as JobrightSkill[]
      expect(matchScore(job('Python', { jdCoreSkills: [] }), profile()).source).toBe('description')
      expect(matchScore(job('Python', { jdCoreSkills: junk }), profile()).source).toBe('description')
      expect(matchScore(job('Python', { jdCoreSkills: null }), profile()).source).toBe('description')
    })

    it('clamps out-of-range scores to 1–3 and keeps the heavier of two spellings', () => {
      const r = matchScore(
        job('', {
          jdCoreSkills: [
            { skill: 'Kubernetes', score: 9, type: 'hard_skill' },
            { skill: 'k8s', score: 1, type: 'hard_skill' },
            { skill: 'Go', score: -2, type: 'hard_skill' }
          ]
        }),
        profile()
      )
      expect(r.missing).toEqual([{ skill: 'Kubernetes', weight: 3, soft: false }])
      expect(r.matched).toEqual([{ skill: 'Go', weight: 1, soft: false }])
    })
  })

  describe('gates', () => {
    it('caps a chemistry-lab Application Engineer job at the gate cap despite transferable Data Analysis', () => {
      const chem = job(
        [
          'Agilent is hiring an Application Engineer for its chromatography lab.',
          "Bachelor's degree in Chemistry, Chemical Engineering or a related field required.",
          'Hands-on HPLC and GC experience.'
        ].join('\n'),
        {
          title: 'Application Engineer',
          jdCoreSkills: [
            { skill: 'Data Analysis', score: 3, type: 'hard_skill' },
            { skill: 'Python', score: 2, type: 'hard_skill' },
            { skill: 'HPLC', score: 1, type: 'hard_skill' }
          ]
        }
      )
      const s = profile({ evidence: 'Data analysis of satellite imagery in Python.' })
      const r = matchScore(chem, s)
      expect(names(r.matched)).toEqual(['Data Analysis', 'Python'])
      expect(r.gates).toEqual([{ kind: 'degree', reason: 'Asks for a degree in chemistry or a life science' }])
      expect(r.score).toBe(GATE_CAP)
    })

    it('passes the degree gate for a field in the same area, an equivalent-experience clause or a preference', () => {
      const s = profile({ degrees: [{ degree: 'Bachelor of Engineering', field: 'Electronics and Communications Engineering' }] })
      expect(matchScore(job("BS in Computer Science, Electrical Engineering or Math. Python."), s).gates).toEqual([])
      expect(matchScore(job("Bachelor's in Chemistry or equivalent practical experience."), s).gates).toEqual([])
      expect(matchScore(job("Preferred qualifications: a degree in Chemistry."), s).gates).toEqual([])
      expect(matchScore(job("Bachelor's in Chemistry required."), profile({ degrees: [] })).gates).toEqual([])
    })

    it('fails a required PhD for a profile without one', () => {
      expect(matchScore(job('PhD in Computer Science required. Python.'), profile()).gates).toEqual([
        { kind: 'degree', reason: 'Asks for a PhD' }
      ])
      expect(matchScore(job("Master's or PhD in Computer Science."), profile()).gates).toEqual([])
      expect(matchScore(job('PhD required.'), profile({ degrees: [{ degree: 'PhD', field: 'Physics' }] })).gates).toEqual([])
    })

    it('fails a PhD that a must-have section lists alone, not one among degree options or under a preference', () => {
      expect(matchScore(job('Minimum Qualifications:\n- PhD in Computer Science\n- Python'), profile()).gates).toEqual([
        { kind: 'degree', reason: 'Asks for a PhD' }
      ])
      const options = 'Minimum Qualifications:\n- M.S. in Computer Science\n- Ph.D. in Computer Science\n- Python'
      expect(matchScore(job(options), profile()).gates).toEqual([])
      expect(matchScore(job('Preferred Qualifications:\n- PhD in Computer Science\n- Python'), profile()).gates).toEqual([])
      expect(matchScore(job('About us:\n- Our founders hold a PhD in physics.\n- Python'), profile()).gates).toEqual([])
    })

    it('reads a dotted degree as one sentence with what follows it', () => {
      expect(matchScore(job('Ph.D. in Computer Science required. Python.'), profile()).gates).toEqual([
        { kind: 'degree', reason: 'Asks for a PhD' }
      ])
      const s = profile({ degrees: [{ degree: 'B.S.', field: 'Computer Science' }] })
      expect(matchScore(job('B.S. in Chemistry required. Python.'), s).gates).toEqual([
        { kind: 'degree', reason: 'Asks for a degree in chemistry or a life science' }
      ])
    })

    it('fails a minimum of years the profile is more than a year short of', () => {
      const r = matchScore(job('7+ years of professional software experience with Python.'), profile({ years: 4 }))
      expect(r.gates).toEqual([{ kind: 'years', reason: 'Asks for 7+ years of experience (you have 4)' }])
      expect(r.score).toBe(GATE_CAP)
      expect(matchScore(job('5+ years of experience. Python.'), profile({ years: 4 })).gates).toEqual([])
      expect(matchScore(job('Python', { minYearsExperience: 8 }), profile({ years: 4 })).gates).toHaveLength(1)
    })

    it('reads years as the largest required minimum, ignoring preferred ones', () => {
      expect(minimumYears(job('3-5 years of experience. 2+ years of Python experience.'))).toBe(3)
      expect(minimumYears(job('Minimum of 4 years’ experience in backend development.'))).toBe(4)
      expect(minimumYears(job('8+ years of experience is a plus.'))).toBeNull()
      expect(minimumYears(job('Founded 20 years ago.'))).toBeNull()
    })

    it('fails a clearance for someone who needs sponsorship, or an active clearance the profile does not hold', () => {
      const obtain = job('Must be able to obtain a Secret clearance. Python.')
      expect(matchScore(obtain, profile()).gates).toEqual([])
      expect(matchScore(obtain, profile({ needsSponsorship: true })).gates.map((g) => g.kind)).toContain('clearance')
      const active = job('Active Secret clearance required. Python.')
      expect(matchScore(active, profile()).gates).toEqual([{ kind: 'clearance', reason: 'Asks for an active security clearance' }])
      expect(matchScore(active, profile({ evidence: 'Hold an active Secret clearance.' })).gates).toEqual([])
    })

    it('fails "no sponsorship" only for a profile that needs a sponsor', () => {
      const j = job('Python. We are unable to sponsor visas for this role.')
      expect(matchScore(j, profile()).gates).toEqual([])
      expect(matchScore(j, profile({ needsSponsorship: true })).gates).toEqual([
        { kind: 'sponsorship', reason: 'Says it does not sponsor visas' }
      ])
      expect(matchScore(j, profile({ needsSponsorship: true })).score).toBe(GATE_CAP)
    })

    it('leaves a score under the cap as it is', () => {
      const r = matchScore(job('Kafka, Terraform, Rust and Python. We do not sponsor visas.'), profile({ needsSponsorship: true }))
      expect(r.score).toBe(25)
    })
  })
})

describe('profileSignals → matchScore', () => {
  function chemist(): MasterProfile {
    const p = emptyProfile()
    p.contact.headline = 'Software Engineer'
    p.contact.workAuthorization = 'F-1 OPT, will need H-1B sponsorship'
    p.skills = [{ category: 'Cloud', items: ['Python', 'AWS (EC2, S3)', 'Postgres'] }]
    p.experience = [
      {
        ...emptyExperience(),
        role: 'Software Engineer',
        start: 'Jan 2023',
        end: 'Present',
        technologies: 'Python, Kubernetes',
        highlights: ['Built data analysis pipelines.']
      }
    ]
    p.education = [{ ...emptyEducation(), degree: 'Master of Science', field: 'Computer Science' }]
    p.gaps = ['No Kafka experience']
    return p
  }

  it('reads degrees and evidence from the profile, never its gaps', () => {
    const s = profileSignals(chemist(), NOW)
    expect(s.degrees).toEqual([{ degree: 'Master of Science', field: 'Computer Science' }])
    expect(s.evidence).toContain('Built data analysis pipelines.')
    expect(s.evidence).not.toContain('Kafka')
    const r = matchScore(job('PostgreSQL, k8s, S3 and Kafka.'), s)
    expect(names(r.matched).sort()).toEqual(['Kubernetes', 'PostgreSQL', 'S3'])
    expect(names(r.missing)).toEqual(['Kafka'])
    expect(r.score).toBe(75)
  })
})

describe('Relevant uses the match score for its skills part', () => {
  const s: ProfileSignals = {
    skills: ['Python', 'Go', 'PostgreSQL', 'AWS', 'Docker'],
    years: 4,
    needsSponsorship: false,
    titles: ['Backend Engineer'],
    location: '',
    remote: true
  }
  const saved = (description: string): Job => ({
    id: 'pasted:x',
    source: 'pasted',
    sourceId: 'x',
    title: 'Backend Engineer',
    company: 'Acme',
    location: '',
    remote: true,
    salary: '',
    postedAt: '2026-10-23T00:00:00Z',
    url: '',
    boardUrl: null,
    description,
    descriptionComplete: true,
    tags: [],
    fetchedAt: '2026-10-23T00:00:00Z'
  })

  it('no longer gives full skill points for three shared skills among many asked for', () => {
    const all = scoreJob(saved('Python, Go and PostgreSQL.'), s, NOW)
    const half = scoreJob(saved('Python, Go, PostgreSQL, Kafka, Terraform and Rust.'), s, NOW)
    expect(all.match.score).toBe(100)
    expect(half.match.score).toBe(50)
    // Half the 35 skill points, give or take the rounding of the total.
    expect(Math.abs(all.score - half.score - 35 * 0.5)).toBeLessThanOrEqual(0.5)
    expect(half.reasons).toContain('Skills: Go, PostgreSQL, Python')
  })
})
