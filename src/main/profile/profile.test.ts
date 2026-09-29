import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyProfile, isProfileEmpty, type MasterProfile } from '@shared/master-profile'
import { parseMasterProfile, serializeMasterProfile } from './format'
import { readProfile, saveProfile } from './store'
import { extractDates, splitList, unshout } from './text'

/** Fictional person: tests must never ship real personal data. */
function sampleProfile(): MasterProfile {
  return {
    contact: {
      name: 'Jane Doe',
      headline: 'Backend Engineer',
      location: 'Springfield, IL',
      email: 'jane@example.com',
      phone: '555-0100',
      linkedin: 'https://www.linkedin.com/in/janedoe/',
      github: 'https://github.com/janedoe',
      website: 'https://janedoe.dev',
      workAuthorization: 'US citizen',
      other: [{ label: 'Portfolio', value: 'https://dribbble.com/janedoe' }]
    },
    summary: 'Backend engineer with 6 years of experience.\n\nLoves boring technology.',
    skills: [
      { category: 'Languages', items: ['Go', 'Python', 'SQL'] },
      { category: 'Cloud & Infrastructure', items: ['AWS (EC2, S3, RDS)', 'Terraform'] }
    ],
    experience: [
      {
        company: 'Acme Corp',
        role: 'Senior Engineer',
        start: 'Jan 2022',
        end: 'Present',
        location: 'Remote',
        employmentType: 'Full-Time',
        project: 'Billing v2',
        projectLink: 'https://acme.example.com/billing',
        technologies: 'Go, Postgres',
        highlights: ['Cut p95 latency by **40%**.', 'Led a team of 4: hiring, reviews and planning.']
      },
      {
        company: 'Initech',
        role: 'Engineer',
        start: '2019',
        end: '2021',
        location: 'Austin, TX',
        employmentType: '',
        project: '',
        projectLink: '',
        technologies: '',
        highlights: []
      }
    ],
    projects: [
      {
        name: 'tiny-queue',
        link: 'https://github.com/janedoe/tiny-queue',
        dates: '2023',
        technologies: 'Rust',
        description: 'A small durable queue.',
        highlights: ['1k GitHub stars']
      }
    ],
    education: [
      {
        institution: 'State University',
        degree: 'Bachelor of Science',
        field: 'Computer Science',
        start: '2015',
        end: '2019',
        location: 'Springfield, IL',
        gpa: '3.8/4.0',
        highlights: ['Thesis: Queues in practice']
      }
    ],
    certifications: [{ name: 'Cloud Practitioner', issuer: 'Example Cloud', date: '2022', link: '' }],
    publications: [
      { title: 'On Queues', venue: 'Journal of Examples', date: '2020', link: 'https://doi.org/10.0000/x', description: '' }
    ],
    gaps: ['No Kubernetes in production', 'Cannot relocate'],
    extraSections: [{ title: 'Awards', body: '- Hackathon winner, 2018\n- Dean’s list' }]
  }
}

describe('master profile format', () => {
  it('round-trips a full profile through Markdown without loss', () => {
    const profile = sampleProfile()
    const md = serializeMasterProfile(profile)
    const { profile: back, warnings } = parseMasterProfile(md)
    expect(warnings).toEqual([])
    expect(back).toEqual(profile)
    // Serialization is stable: a second pass writes the same bytes.
    expect(serializeMasterProfile(back)).toBe(md)
  })

  it('writes readable Markdown with one section per resume part', () => {
    const md = serializeMasterProfile(sampleProfile())
    for (const section of [
      'Contact',
      'Summary',
      'Skills',
      'Experience',
      'Projects',
      'Education',
      'Certifications',
      'Publications',
      'Gaps and constraints',
      'Awards'
    ]) {
      expect(md).toContain(`\n## ${section}\n`)
    }
    expect(md).toContain('### Acme Corp\n\n- Role: Senior Engineer\n- Start: Jan 2022\n- End: Present')
    expect(md).toContain('- Highlights:\n  - Cut p95 latency by **40%**.')
    expect(md).toContain('- Cloud & Infrastructure: AWS (EC2, S3, RDS), Terraform')
  })

  it('serializes an empty profile that reads back as empty, listing the contact fields to fill', () => {
    const md = serializeMasterProfile(emptyProfile())
    expect(md).toContain('- Name:\n- Headline:\n- Location:\n- Email:')
    const { profile, warnings } = parseMasterProfile(md)
    expect(warnings).toEqual([])
    expect(isProfileEmpty(profile)).toBe(true)
  })

  it('credits the skill source and ships no real personal data', () => {
    const md = serializeMasterProfile(emptyProfile())
    expect(md).toContain('silentashish/claude-resume-generator-skill@712bee3/assets/master_profile.example.md')
    for (const personal of ['Ashish', 'NASA', 'Houzz', 'Huntsville', 'Atlanta', 'UAH']) {
      expect(md).not.toContain(personal)
    }
  })

  it('reads hand-written variations: bold keys, the (link: ...) convention, aliases and bare bullets', () => {
    const md = `# Master Profile

## Contact
- **Name:** Jane Doe
- GitHub: github.com/janedoe (link: https://github.com/janedoe)
- Twitter: @jane

## Technical Skills
- **Languages:** Go, Python
- Bash

## Work Experience

### Acme Corp
- Title: Engineer
- Dates: Jan 2020 - Mar 2022
- Tech stack: Go
- Shipped the thing.
- Impact: saved **$1M** a year
- Highlights:
  - Nested one
    that wraps onto a second line
`
    const { profile, warnings } = parseMasterProfile(md)
    expect(warnings).toEqual([])
    expect(profile.contact.name).toBe('Jane Doe')
    expect(profile.contact.github).toBe('https://github.com/janedoe')
    expect(profile.contact.other).toEqual([{ label: 'Twitter', value: '@jane' }])
    expect(profile.skills).toEqual([
      { category: 'Languages', items: ['Go', 'Python'] },
      { category: 'Other', items: ['Bash'] }
    ])
    expect(profile.experience[0]).toMatchObject({
      company: 'Acme Corp',
      role: 'Engineer',
      start: 'Jan 2020',
      end: 'Mar 2022',
      technologies: 'Go',
      highlights: ['Shipped the thing.', 'Impact: saved **$1M** a year', 'Nested one that wraps onto a second line']
    })
  })

  it('keeps unknown sections verbatim and moves one titled like a known section out of the way', () => {
    const profile = emptyProfile()
    profile.extraSections = [
      { title: 'Volunteering', body: '### Food bank\n\nSaturdays since 2019.' },
      { title: 'Skills', body: 'Juggling' }
    ]
    const back = parseMasterProfile(serializeMasterProfile(profile)).profile
    expect(back.extraSections).toEqual([
      { title: 'Volunteering', body: '### Food bank\n\nSaturdays since 2019.' },
      { title: 'Skills (notes)', body: 'Juggling' }
    ])
    expect(back.skills).toEqual([])
  })

  it('reads the placeholder profile written by the first Huntgry release', () => {
    const md = `# Master Profile

## Contact

- Name: Your Name
- LinkedIn: linkedin.com/in/yourhandle (link: https://www.linkedin.com/in/yourhandle/)

## Experience

### Company Name - Job Title
YYYY - Present | City, State
Project link: Project Name - https://example.com/project

- What you did. Put **the measurable result** in bold.

**Technologies:** Language, Framework

## Education

### University Name
Degree, Field, 2019

## Skills

Group by category, honestly.

- **Languages:** Language A, Language B *(rusty)*

## Certifications

- Certification Name, Issuer, 2021
`
    const { profile, warnings } = parseMasterProfile(md)
    expect(profile.contact.linkedin).toBe('https://www.linkedin.com/in/yourhandle/')
    expect(profile.experience[0]).toMatchObject({
      company: 'Company Name',
      role: 'Job Title',
      technologies: 'Language, Framework',
      projectLink: 'https://example.com/project',
      highlights: ['What you did. Put **the measurable result** in bold.']
    })
    expect(profile.education[0]).toMatchObject({ degree: 'Degree', field: 'Field', end: '2019' })
    expect(profile.skills[0]).toEqual({ category: 'Languages', items: ['Language A', 'Language B *(rusty)*'] })
    expect(profile.certifications[0]).toMatchObject({ name: 'Certification Name', issuer: 'Issuer', date: '2021' })
    // "YYYY - Present" is not a date and prose in Skills has no field: both are reported, with line numbers.
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/^Line 11 \(Experience\): "YYYY - Present \| City, State"/)
    expect(warnings[1]).toMatch(/^Line 25 \(Skills\): "Group by category, honestly\."/)
  })

  it('ignores the header comment but reports comments inside sections', () => {
    const md = `<!--\n## Experience\n### Fake\n-->\n# Master Profile\n\n## Summary\n\nHello <!-- note --> world\n`
    const { profile, warnings } = parseMasterProfile(md)
    expect(profile.experience).toEqual([])
    expect(profile.summary).toBe('Hello  world')
    expect(warnings).toEqual(['Line 9: HTML comments are not kept when saving from Huntgry.'])
  })
})

describe('text helpers', () => {
  it('extracts date ranges and single dates without mistaking phone numbers or counts', () => {
    expect(extractDates('NASA IMPACT\tAug 2024 – Present')).toEqual({ start: 'Aug 2024', end: 'Present', rest: 'NASA IMPACT' })
    expect(extractDates('03/2019 to 05/2021')).toMatchObject({ start: '03/2019', end: '05/2021' })
    expect(extractDates('Summer 2018 - Fall 2019')).toMatchObject({ start: 'Summer 2018', end: 'Fall 2019' })
    expect(extractDates('Degree, Field, 2019', true)).toEqual({ start: '', end: '2019', rest: 'Degree, Field' })
    expect(extractDates('(256) 288-6948')).toBeNull()
    expect(extractDates('handling 5,000+ images daily', true)).toBeNull()
    expect(extractDates('Maybe 2020')).toBeNull()
  })

  it('splits lists on commas outside brackets and un-shouts names', () => {
    expect(splitList('AWS (EC2, S3), Docker; Kubernetes,')).toEqual(['AWS (EC2, S3)', 'Docker', 'Kubernetes'])
    expect(unshout('JANE O’NEIL-DOE')).toBe('Jane O’Neil-Doe')
    expect(unshout('Jane McDoe')).toBe('Jane McDoe')
  })
})

describe('profile store', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'huntgry-profile-')))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('reads, saves atomically and re-reads the saved content', async () => {
    const file = join(tmp, 'master-profile.md')
    await writeFile(file, serializeMasterProfile(emptyProfile()), { mode: 0o640 })
    const doc = await readProfile(file)
    expect(isProfileEmpty(doc.profile)).toBe(true)

    const result = await saveProfile(file, sampleProfile(), doc.version)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.profile).toEqual(sampleProfile())
    expect(result.document.version).not.toBe(doc.version)
    expect(await readFile(file, 'utf8')).toBe(serializeMasterProfile(sampleProfile()))
    expect((await stat(file)).mode & 0o777).toBe(0o640)
    // No temp files left behind.
    expect(await readdir(tmp)).toEqual(['master-profile.md'])
  })

  it('refuses to save over edits made on disk since the last read', async () => {
    const file = join(tmp, 'master-profile.md')
    await writeFile(file, serializeMasterProfile(emptyProfile()))
    const doc = await readProfile(file)
    await writeFile(file, '# Master Profile\n\n## Summary\n\nEdited by hand.\n')

    const result = await saveProfile(file, sampleProfile(), doc.version)
    expect(result).toMatchObject({ ok: false, conflict: true })
    expect(await readFile(file, 'utf8')).toContain('Edited by hand.')
  })

  it('writes through a symlinked profile and keeps the link', async () => {
    const real = join(tmp, 'dotfiles', 'profile.md')
    await mkdir(join(tmp, 'dotfiles'))
    await writeFile(real, serializeMasterProfile(emptyProfile()))
    const link = join(tmp, 'master-profile.md')
    await symlink(real, link)

    const doc = await readProfile(link)
    const result = await saveProfile(link, sampleProfile(), doc.version)
    expect(result.ok).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toContain('Jane Doe')
  })

  it.skipIf(process.getuid?.() === 0)('reports a write failure without touching the file', async () => {
    const dir = join(tmp, 'locked')
    await mkdir(dir)
    const file = join(dir, 'master-profile.md')
    await writeFile(file, serializeMasterProfile(emptyProfile()))
    const doc = await readProfile(file)
    await chmod(dir, 0o500)
    try {
      const result = await saveProfile(file, sampleProfile(), doc.version)
      expect(result).toMatchObject({ ok: false, conflict: false })
      expect(await readFile(file, 'utf8')).toBe(serializeMasterProfile(emptyProfile()))
    } finally {
      await chmod(dir, 0o700)
    }
  })
})
