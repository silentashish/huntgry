import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPdf } from '../resume/test-fixtures'
import { absentTerms, rescoreApplication, scoreApplication } from './rescore'
import { normalizeMatch, normalizeTracking, readTracking, updateTracking } from './tracking'

const FIXTURES = join(__dirname, '../../shared/fixtures')
const ID = 'backend-engineer/acme/123'
const NOW = new Date('2026-10-24T12:00:00Z')

const PROFILE = `# Master Profile

## Contact

- Name: Sam Rivera
- Location: Austin, TX
- Work authorization: US citizen

## Experience

### Acme Logistics - Software Engineer
Jan 2022 - Present | Austin, TX

- Built order-routing services in Python and Go.
- Ran them on Kubernetes, provisioned with Terraform.

**Technologies:** Python, Go, PostgreSQL, AWS, Docker, Kubernetes, Terraform

## Education

### UT Austin
B.S. in Computer Science | 2017 - 2021

## Skills

- **Languages:** Python, Go, SQL
- **Infra:** AWS, Docker, Kubernetes, Terraform, PostgreSQL
`

const REPORT = {
  ok: true,
  verify: {
    ok: true,
    results: [
      { check: 'pages', passed: true, detail: '1 page', hard: true },
      {
        check: 'jd_keyword_coverage',
        passed: true,
        detail: "31/40 substantive JD terms appear in the resume. Absent: ['Kafka', 'event streaming', \"Kubernetes\"]",
        hard: false
      }
    ]
  }
}

let ws: string
let folder: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-rescore-'))
  folder = join(ws, ID)
  await mkdir(folder, { recursive: true })
  await writeFile(join(ws, 'master-profile.md'), PROFILE)
  await copyFile(join(FIXTURES, 'tailored-job.md'), join(folder, 'job-description.md'))
  await copyFile(join(FIXTURES, 'tailored-resume_data.json'), join(folder, 'resume_data.json'))
  await writeFile(join(folder, 'build-report.json'), JSON.stringify(REPORT))
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

const stored = async () => JSON.parse(await readFile(join(folder, 'huntgry.json'), 'utf8'))

/** A saved job for the fixture's posting URL, as `.huntgry/jobs/<id>.json` holds it. */
const savedJobJson = () => ({
  id: 'hiring.cafe:1',
  source: 'hiring.cafe',
  sourceId: '1',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Austin, TX',
  remote: false,
  salary: '',
  postedAt: null,
  url: 'https://boards.greenhouse.io/acme/jobs/123',
  boardUrl: null,
  description: '',
  descriptionComplete: false,
  tags: [] as string[],
  fetchedAt: NOW.toISOString()
})

describe('rescoreApplication', () => {
  it('stores profile fit, resume coverage, surfaced and what the resume left out in huntgry.json', async () => {
    const match = await rescoreApplication(ws, ID, { runId: 'run-1', now: NOW })
    const expected = {
      // Required: Python, Go, PostgreSQL, AWS, Kafka, Docker, Kubernetes; Terraform is a plus (0.5).
      profileFit: Math.round((6.5 / 7.5) * 100),
      resumeCoverage: Math.round((5 / 7.5) * 100),
      surfaced: Math.round((5 / 6.5) * 100),
      requirements: 8,
      leftOut: ['Kubernetes', 'Terraform'],
      absent: ['Kafka', 'event streaming', 'Kubernetes'],
      resumeFrom: 'resume_data.json',
      source: 'description',
      runId: 'run-1',
      at: NOW.toISOString()
    }
    expect(match).toEqual(expected)
    expect((await stored()).match).toEqual(expected)
    // Only huntgry.json is written: the skill's files stay as they were.
    expect(await readFile(join(folder, 'resume_data.json'), 'utf8')).toBe(await readFile(join(FIXTURES, 'tailored-resume_data.json'), 'utf8'))
  })

  it('keeps the status and notes it found, and a re-run replaces the scores', async () => {
    await updateTracking(folder, { status: 'applied', notes: 'Referral from Kim' }, NOW)
    await rescoreApplication(ws, ID, { runId: 'run-1', now: NOW })
    const data = JSON.parse(await readFile(join(FIXTURES, 'tailored-resume_data.json'), 'utf8'))
    data.skills.push({ label: 'Platform', items: 'Kubernetes, Terraform' })
    await writeFile(join(folder, 'resume_data.json'), JSON.stringify(data))
    await rescoreApplication(ws, ID, { runId: 'run-2', now: NOW })
    const t = await readTracking(folder)
    expect(t).toMatchObject({ status: 'applied', notes: 'Referral from Kim' })
    expect(t.match).toMatchObject({ runId: 'run-2', surfaced: 100, leftOut: [] })
    expect(t.match?.resumeCoverage).toBe(t.match?.profileFit)
  })

  it("falls back to resume.pdf's text when there is no resume_data.json", async () => {
    await rm(join(folder, 'resume_data.json'))
    await writeFile(
      join(folder, 'resume.pdf'),
      buildPdf([
        { x: 72, y: 720, text: 'Sam Rivera' },
        { x: 72, y: 700, text: 'Built services in Python and Go on AWS with PostgreSQL and Docker.' }
      ])
    )
    const match = await rescoreApplication(ws, ID, { now: NOW })
    expect(match).toMatchObject({ resumeFrom: 'resume.pdf', leftOut: ['Kubernetes', 'Terraform'], surfaced: Math.round((5 / 6.5) * 100) })
  })

  it('also reads an unparseable resume_data.json as missing', async () => {
    await writeFile(join(folder, 'resume_data.json'), '{ not json')
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
    await expect(readFile(join(folder, 'huntgry.json'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('never reads a symlinked resume file', async () => {
    const outside = join(ws, 'elsewhere.json')
    await copyFile(join(FIXTURES, 'tailored-resume_data.json'), outside)
    await rm(join(folder, 'resume_data.json'))
    await symlink(outside, join(folder, 'resume_data.json'))
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
  })

  it('writes nothing without a master profile or a job description', async () => {
    await rm(join(ws, 'master-profile.md'))
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
    await writeFile(join(ws, 'master-profile.md'), PROFILE)
    await rm(join(folder, 'job-description.md'))
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
    await expect(readFile(join(folder, 'huntgry.json'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('reads the older master_profile.md name', async () => {
    await rm(join(ws, 'master-profile.md'))
    await writeFile(join(ws, 'master_profile.md'), PROFILE)
    expect(await rescoreApplication(ws, ID, { now: NOW })).toMatchObject({ requirements: 8 })
  })

  it('drops an earlier score when the job no longer names a requirement', async () => {
    await rescoreApplication(ws, ID, { now: NOW })
    await writeFile(join(folder, 'job-description.md'), '# Office Manager\n\nRun the front desk.')
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
    expect((await stored()).match).toBeUndefined()
  })

  it('adds the saved job of the same posting (its board facts) to the requirements', async () => {
    await mkdir(join(ws, '.huntgry', 'jobs'), { recursive: true })
    const job = { ...savedJobJson(), tags: ['GraphQL'], minYearsExperience: 8 }
    await writeFile(join(ws, '.huntgry', 'jobs', 'hiring.cafe-1.json'), JSON.stringify(job))
    const match = await rescoreApplication(ws, ID, { now: NOW })
    expect(match?.requirements).toBe(9)
    expect(match?.gates).toEqual(['Asks for 8+ years of experience (you have 4.8)'])
    expect(match?.profileFit).toBe(40)
  })

  it("uses the saved job's weighted Jobright skills, as profile fit does (review)", async () => {
    await mkdir(join(ws, '.huntgry', 'jobs'), { recursive: true })
    const job = {
      ...savedJobJson(),
      jdCoreSkills: [
        { skill: 'Python', score: 3, type: 'hard_skill' },
        { skill: 'Kafka', score: 1, type: 'hard_skill' }
      ]
    }
    await writeFile(join(ws, '.huntgry', 'jobs', 'hiring.cafe-1.json'), JSON.stringify(job))
    const match = await rescoreApplication(ws, ID, { now: NOW })
    // Python (3) of Python + Kafka (4); the description's eight requirements are not used.
    expect(match).toMatchObject({ source: 'jobright-skills', requirements: 2, profileFit: 75, resumeCoverage: 75, surfaced: 100 })
  })

  it('drops an earlier score when the job description or the profile is gone (review)', async () => {
    expect(await rescoreApplication(ws, ID, { now: NOW })).not.toBeNull()
    await rm(join(folder, 'job-description.md'))
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
    expect((await stored()).match).toBeUndefined()

    await copyFile(join(FIXTURES, 'tailored-job.md'), join(folder, 'job-description.md'))
    expect(await rescoreApplication(ws, ID, { now: NOW })).not.toBeNull()
    await rm(join(ws, 'master-profile.md'))
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
    expect((await stored()).match).toBeUndefined()
  })

  it('drops an earlier score when a rebuild removed the resume', async () => {
    await rescoreApplication(ws, ID, { now: NOW })
    await rm(join(folder, 'resume_data.json'))
    expect(await rescoreApplication(ws, ID, { now: NOW })).toBeNull()
    expect((await stored()).match).toBeUndefined()
  })

  it('does not rewrite huntgry.json when the scores did not change', async () => {
    const first = await rescoreApplication(ws, ID, { runId: 'run-1', now: NOW })
    const again = await rescoreApplication(ws, ID, { runId: 'run-1', now: new Date('2026-10-25T00:00:00Z') })
    expect(again).toEqual(first)
    expect((await stored()).match.at).toBe(NOW.toISOString())
  })

  it('refuses an application id outside the workspace', async () => {
    await expect(rescoreApplication(ws, '../x/y', { now: NOW })).rejects.toThrow(/Invalid application id/)
  })
})

describe('scoreApplication', () => {
  it('returns the match rescoreApplication stores, writes nothing, and exposes unbacked requirements (#152)', async () => {
    // The resume claims Kafka, which the profile has no evidence for.
    const data = JSON.parse(await readFile(join(FIXTURES, 'tailored-resume_data.json'), 'utf8'))
    data.skills.push({ label: 'Streaming', items: 'Kafka' })
    await writeFile(join(folder, 'resume_data.json'), JSON.stringify(data))
    const score = await scoreApplication(ws, ID, { runId: 'run-1', now: NOW })
    await expect(readFile(join(folder, 'huntgry.json'), 'utf8')).rejects.toThrow()
    expect(score!.coverage.unbacked.map((r) => r.skill)).toEqual(['Kafka'])
    expect(await rescoreApplication(ws, ID, { runId: 'run-1', now: NOW })).toEqual(score!.match)
  })

  it('is null when the resume cannot be scored', async () => {
    await rm(join(folder, 'resume_data.json'))
    expect(await scoreApplication(ws, ID, { now: NOW })).toBeNull()
  })
})

describe('absentTerms', () => {
  it("reads the skill's jd_keyword_coverage Absent list", () => {
    expect(absentTerms(JSON.stringify(REPORT))).toEqual(['Kafka', 'event streaming', 'Kubernetes'])
  })

  it('is empty for a missing, unreadable or check-less report', () => {
    expect(absentTerms(null)).toEqual([])
    expect(absentTerms('{')).toEqual([])
    expect(absentTerms(JSON.stringify({ verify: { results: [{ check: 'jd_keyword_coverage', detail: '40/40 terms appear.' }] } }))).toEqual([])
    expect(absentTerms(JSON.stringify({ verify: { results: 'x' } }))).toEqual([])
  })
})

describe('normalizeMatch', () => {
  const good = { profileFit: 82, resumeCoverage: 74, surfaced: 90, requirements: 9, leftOut: ['Kafka'], resumeFrom: 'resume_data.json', source: 'description', at: NOW.toISOString() }

  it('keeps a well-formed match through normalizeTracking', () => {
    expect(normalizeTracking({ status: 'generated', notes: '', match: good }).match).toEqual(good)
  })

  it('drops a malformed one, and a surfaced share over 100', () => {
    expect(normalizeMatch({ ...good, profileFit: 101 })).toBeUndefined()
    expect(normalizeMatch({ ...good, resumeCoverage: '74' })).toBeUndefined()
    expect(normalizeMatch({ ...good, requirements: 0 })).toBeUndefined()
    expect(normalizeMatch({ ...good, resumeFrom: 'resume.tex' })).toBeUndefined()
    expect(normalizeMatch({ ...good, at: 'yesterday' })).toBeUndefined()
    expect(normalizeMatch('x')).toBeUndefined()
    const { surfaced: _surfaced, ...withoutSurfaced } = good
    expect(normalizeMatch({ ...good, surfaced: 140 })).toStrictEqual(withoutSurfaced)
  })

  it('bounds the lists', () => {
    const many = Array.from({ length: 50 }, (_, i) => `Skill ${i}`)
    const m = normalizeMatch({ ...good, leftOut: [...many, 3, ''], absent: many, gates: [] })!
    expect(m.leftOut).toHaveLength(20)
    expect(m.absent).toHaveLength(20)
    expect(m.gates).toBeUndefined()
  })
})
