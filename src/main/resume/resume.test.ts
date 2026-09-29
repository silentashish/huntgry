import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMasterProfile, serializeMasterProfile } from '../profile/format'
import { readResumeLines } from './extract'
import { parseResume } from './parse'
import { buildDocx, buildPdf, buildZip, type DocxParagraph } from './test-fixtures'

let tmp: string
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'huntgry-resume-')))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function file(name: string, content: Buffer | string): Promise<string> {
  const path = join(tmp, name)
  await writeFile(path, content)
  return path
}

const tab = { tab: true } as const
const p = (...runs: DocxParagraph['runs']): DocxParagraph => ({ runs })
const b = (...runs: DocxParagraph['runs']): DocxParagraph => ({ runs, bullet: true })

/** A fictional resume laid out like a typical Word template: tab stops, list bullets, hyperlinks. */
function sampleDocx(): Buffer {
  return buildDocx(
    [
      p('Springfield, IL | (555) 010-0100 | jane@example.com | ', { link: 'https://www.linkedin.com/in/janedoe/', text: 'LinkedIn' }, ' | ', { link: 'https://github.com/janedoe', text: 'GitHub' }, ' | janedoe.dev'),
      p('SUMMARY'),
      p('Backend Engineer with 6+ years building payment systems. Calm on call.'),
      p('TECHNICAL SKILLS'),
      b('Languages: Go, Python, SQL'),
      b('Cloud & Infrastructure: AWS (EC2, S3, RDS), Terraform'),
      p('EXPERIENCE'),
      p(tab, 'Acme Corp', tab, 'Jan 2022 – Present'),
      p(tab, 'Senior Engineer (Payments) | Full-Time, Remote', tab, 'Austin, TX'),
      b('Rebuilt the billing API, cutting p95 latency by 40%.'),
      b('Led a team of four.'),
      p({ link: 'https://acme.example.com/billing', text: 'Project: Billing v2' }),
      p(tab, 'Initech', tab, 'Jun 2019 – Dec 2021'),
      p(tab, 'Software Engineer | Hybrid', tab, 'Berlin, Germany'),
      b('Migrated reports to Postgres.'),
      p('PERSONAL PROJECTS'),
      p('tiny-queue — a durable queue  |  ', { link: 'https://github.com/janedoe/tiny-queue', text: 'GitHub' }),
      b('Rust, 1k stars.'),
      p('EDUCATION'),
      p('State University', tab, 'Aug 2015 – May 2019'),
      p('Bachelor of Science, Computer Science | GPA: 3.8/4.0', tab, 'Springfield, IL'),
      b('Thesis: Queues in practice'),
      p('CERTIFICATIONS'),
      p('Cloud Practitioner – Example Cloud, 2022  |  Scrum Master'),
      p('PUBLICATIONS'),
      b({ link: 'https://doi.org/10.0000/x', text: 'On Queues. Journal of Examples, 2020.' }),
      p('AWARDS'),
      b('Hackathon winner, 2018')
    ],
    [p('JANE DOE')]
  )
}

describe('resume import', () => {
  it('parses a .docx resume into a draft profile', async () => {
    const { profile, warnings } = parseResume(await readResumeLines(await file('resume.docx', sampleDocx())))
    expect(warnings).toEqual(['Kept as extra sections: Awards.'])
    expect(profile.contact).toEqual({
      name: 'Jane Doe',
      headline: 'Backend Engineer',
      location: 'Springfield, IL',
      email: 'jane@example.com',
      phone: '(555) 010-0100',
      linkedin: 'https://www.linkedin.com/in/janedoe/',
      github: 'https://github.com/janedoe',
      website: 'https://janedoe.dev',
      workAuthorization: '',
      other: []
    })
    expect(profile.summary).toBe('Backend Engineer with 6+ years building payment systems. Calm on call.')
    expect(profile.skills).toEqual([
      { category: 'Languages', items: ['Go', 'Python', 'SQL'] },
      { category: 'Cloud & Infrastructure', items: ['AWS (EC2, S3, RDS)', 'Terraform'] }
    ])
    expect(profile.experience).toEqual([
      {
        company: 'Acme Corp',
        role: 'Senior Engineer (Payments)',
        start: 'Jan 2022',
        end: 'Present',
        location: 'Austin, TX',
        employmentType: 'Full-Time, Remote',
        project: 'Billing v2',
        projectLink: 'https://acme.example.com/billing',
        technologies: '',
        highlights: ['Rebuilt the billing API, cutting p95 latency by 40%.', 'Led a team of four.']
      },
      {
        company: 'Initech',
        role: 'Software Engineer',
        start: 'Jun 2019',
        end: 'Dec 2021',
        location: 'Berlin, Germany',
        employmentType: 'Hybrid',
        project: '',
        projectLink: '',
        technologies: '',
        highlights: ['Migrated reports to Postgres.']
      }
    ])
    expect(profile.projects).toEqual([
      {
        name: 'tiny-queue — a durable queue',
        link: 'https://github.com/janedoe/tiny-queue',
        dates: '',
        technologies: '',
        description: '',
        highlights: ['Rust, 1k stars.']
      }
    ])
    expect(profile.education).toEqual([
      {
        institution: 'State University',
        degree: 'Bachelor of Science',
        field: 'Computer Science',
        start: 'Aug 2015',
        end: 'May 2019',
        location: 'Springfield, IL',
        gpa: '3.8/4.0',
        highlights: ['Thesis: Queues in practice']
      }
    ])
    expect(profile.certifications).toEqual([
      { name: 'Cloud Practitioner', issuer: 'Example Cloud', date: '2022', link: '' },
      { name: 'Scrum Master', issuer: '', date: '', link: '' }
    ])
    expect(profile.publications).toEqual([
      { title: 'On Queues. Journal of Examples, 2020.', venue: '', date: '', link: 'https://doi.org/10.0000/x', description: '' }
    ])
    expect(profile.extraSections).toEqual([{ title: 'Awards', body: '- Hackathon winner, 2018' }])

    // The draft is saved through the Markdown format: it must survive that unchanged.
    expect(parseMasterProfile(serializeMasterProfile(profile)).profile).toEqual(profile)
  })

  it('parses a PDF resume: glyph bullets, right-aligned dates, wrapped bullets and link annotations', async () => {
    const pdf = buildPdf(
      [
        { x: 250, y: 750, text: 'JANE DOE', size: 14 },
        { x: 170, y: 732, text: 'Springfield, IL | jane@example.com | LinkedIn' },
        { x: 50, y: 700, text: 'EXPERIENCE', size: 11 },
        { x: 50, y: 684, text: 'Acme Corp' },
        { x: 480, y: 684, text: 'Jan 2022 – Present' },
        { x: 50, y: 670, text: 'Senior Engineer' },
        { x: 500, y: 670, text: 'Austin, TX' },
        { x: 60, y: 654, text: '•' },
        { x: 72, y: 654, text: 'Rebuilt the billing API and the ledger service, cutting p95' },
        { x: 72, y: 642, text: 'latency by 40%.' },
        { x: 60, y: 628, text: '•' },
        { x: 72, y: 628, text: 'Led a team of four.' },
        { x: 50, y: 600, text: 'EDUCATION', size: 11 },
        { x: 50, y: 584, text: 'State University' },
        { x: 480, y: 584, text: '2015 – 2019' },
        { x: 50, y: 570, text: 'B.S. in Computer Science' }
      ],
      [{ rect: [380, 728, 420, 742], url: 'https://www.linkedin.com/in/janedoe/' }]
    )
    const lines = await readResumeLines(await file('resume.pdf', pdf))
    expect(lines.slice(3, 7)).toEqual([
      { text: 'Acme Corp\tJan 2022 – Present', bullet: false, links: [] },
      { text: 'Senior Engineer\tAustin, TX', bullet: false, links: [] },
      { text: 'Rebuilt the billing API and the ledger service, cutting p95 latency by 40%.', bullet: true, links: [] },
      { text: 'Led a team of four.', bullet: true, links: [] }
    ])

    const { profile } = parseResume(lines)
    expect(profile.contact).toMatchObject({
      name: 'Jane Doe',
      location: 'Springfield, IL',
      email: 'jane@example.com',
      linkedin: 'https://www.linkedin.com/in/janedoe/'
    })
    expect(profile.experience).toEqual([
      expect.objectContaining({
        company: 'Acme Corp',
        role: 'Senior Engineer',
        start: 'Jan 2022',
        end: 'Present',
        location: 'Austin, TX',
        highlights: ['Rebuilt the billing API and the ledger service, cutting p95 latency by 40%.', 'Led a team of four.']
      })
    ])
    expect(profile.education[0]).toMatchObject({
      institution: 'State University',
      degree: 'B.S.',
      field: 'Computer Science',
      start: '2015',
      end: '2019'
    })
  })

  it('parses a plain-text resume with wrapped bullets and one-line job headers', async () => {
    const text = `Jane Doe
jane@example.com · 555-0100 · https://janedoe.dev

Experience
Senior Engineer at Acme Corp | 2019 - 2021
- Rebuilt the billing API, cutting latency
  by 40%.
- Mentored two engineers.

Skills
Go, Python, SQL
`
    const { profile, warnings } = parseResume(await readResumeLines(await file('resume.txt', text)))
    expect(warnings).toEqual([])
    expect(profile.contact).toMatchObject({ name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100', website: 'https://janedoe.dev' })
    expect(profile.experience[0]).toMatchObject({
      company: 'Acme Corp',
      role: 'Senior Engineer',
      start: '2019',
      end: '2021',
      highlights: ['Rebuilt the billing API, cutting latency by 40%.', 'Mentored two engineers.']
    })
    expect(profile.skills).toEqual([{ category: 'Skills', items: ['Go', 'Python', 'SQL'] }])
  })

  it('warns when nothing resume-like is found', () => {
    const { warnings } = parseResume([{ text: 'shopping list: eggs, milk', bullet: false, links: [] }])
    expect(warnings.join(' ')).toMatch(/No resume sections/)
  })

  it('rejects unsupported and malformed files with a clear message', async () => {
    await expect(readResumeLines(await file('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])))).rejects.toThrow(/\.doc files are not supported/)
    await expect(readResumeLines(await file('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])))).rejects.toThrow(/Unsupported file type/)
    await expect(readResumeLines(await file('fake.docx', 'not a zip'))).rejects.toThrow(/does not look like a valid \.docx/)
    const zipWithoutDocument = buildZip([['hello.txt', 'hi', true]])
    await expect(readResumeLines(await file('empty.docx', zipWithoutDocument))).rejects.toThrow(/word\/document\.xml is missing/)
    await expect(readResumeLines(await file('sheet.xlsx', zipWithoutDocument))).rejects.toThrow(/\.xlsx files are not supported/)
  })
})
