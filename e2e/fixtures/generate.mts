/**
 * Regenerates the binary fixtures from code, so no real person's resume is
 * ever committed: the sample resumes used by the import flow and the tiny
 * `resume.pdf` of each demo application. Run with `node e2e/fixtures/generate.mts`
 * (Node ≥ 22.18 strips the types itself) and commit the result.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocx, buildPdf, type DocxParagraph } from '../../src/main/resume/test-fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tab = { tab: true } as const
const p = (...runs: DocxParagraph['runs']): DocxParagraph => ({ runs })
const b = (...runs: DocxParagraph['runs']): DocxParagraph => ({ runs, bullet: true })

/** A fictional resume laid out like a typical Word template: name in the header, tab stops, bullets, links. */
const SAMPLE_DOCX = buildDocx(
  [
    p('Portland, OR | (555) 010-0142 | jordan.example@example.com | ', { link: 'https://www.linkedin.com/in/jordan-example/', text: 'LinkedIn' }, ' | ', { link: 'https://github.com/jordan-example', text: 'GitHub' }),
    p('SUMMARY'),
    p('Full-Stack Engineer with 5+ years shipping web products in TypeScript and Go.'),
    p('TECHNICAL SKILLS'),
    b('Languages: TypeScript, Go, SQL'),
    b('Frameworks: React, Node.js, PostgreSQL'),
    p('EXPERIENCE'),
    p(tab, 'Vandelay Industries', tab, 'Mar 2021 – Present'),
    p(tab, 'Senior Full-Stack Engineer | Full-Time, Remote', tab, 'Portland, OR'),
    b('Shipped the customer portal used by 30k accounts.'),
    b('Cut page load time by 55%.'),
    p(tab, 'Wonka Digital', tab, 'Jul 2018 – Feb 2021'),
    p(tab, 'Software Engineer | Hybrid', tab, 'Denver, CO'),
    b('Built the order tracking API in Go.'),
    p('PERSONAL PROJECTS'),
    p('roster — a scheduling tool  |  ', { link: 'https://github.com/jordan-example/roster', text: 'GitHub' }),
    b('React and Go, used by two local clubs.'),
    p('EDUCATION'),
    p('Pacific State University', tab, 'Aug 2014 – May 2018'),
    p('Bachelor of Science, Computer Science | GPA: 3.7/4.0', tab, 'Portland, OR'),
    p('CERTIFICATIONS'),
    p('Cloud Practitioner – Example Cloud, 2023')
  ],
  [p('JORDAN EXAMPLE')]
)

/** The same fictional resume as a one-page PDF (name on top, then sections). */
function samplePdf(): Buffer {
  const lines: Array<[string, number?]> = [
    ['Jordan Example', 16],
    ['Portland, OR | (555) 010-0142 | jordan.example@example.com'],
    ['SUMMARY', 11],
    ['Full-Stack Engineer with 5+ years shipping web products in TypeScript and Go.'],
    ['TECHNICAL SKILLS', 11],
    ['• Languages: TypeScript, Go, SQL'],
    ['• Frameworks: React, Node.js, PostgreSQL'],
    ['EXPERIENCE', 11],
    ['Vandelay Industries – Senior Full-Stack Engineer, Mar 2021 – Present, Portland, OR'],
    ['• Shipped the customer portal used by 30k accounts.'],
    ['Wonka Digital – Software Engineer, Jul 2018 – Feb 2021, Denver, CO'],
    ['• Built the order tracking API in Go.'],
    ['EDUCATION', 11],
    ['Pacific State University – Bachelor of Science, Computer Science, Aug 2014 – May 2018']
  ]
  return buildPdf(lines.map(([text, size], i) => ({ x: 56, y: 740 - i * 18, text, size })))
}

/** A generated application's `resume.pdf`: valid, one page, a few lines. */
function applicationPdf(role: string, company: string): Buffer {
  return buildPdf([
    { x: 56, y: 740, text: 'Alex Rivera', size: 16 },
    { x: 56, y: 720, text: `${role} – tailored for ${company}` },
    { x: 56, y: 700, text: 'alex.rivera@example.com | Portland, OR' }
  ])
}

/** A generated application's `cover.pdf`. */
function coverPdf(company: string): Buffer {
  return buildPdf([
    { x: 56, y: 740, text: 'Alex Rivera', size: 16 },
    { x: 56, y: 720, text: `Dear ${company} hiring team,` },
    { x: 56, y: 700, text: 'I build backend systems that stay up.' }
  ])
}

async function write(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  console.log(`wrote ${path} (${data.length} bytes)`)
}

await write(join(here, 'resumes/sample-resume.docx'), SAMPLE_DOCX)
await write(join(here, 'resumes/sample-resume.pdf'), samplePdf())
await write(join(here, 'workspaces/demo/software-engineer/acme/acme-4821/resume.pdf'), applicationPdf('Senior Software Engineer', 'Acme Corp'))
await write(join(here, 'workspaces/demo/backend-engineer/globex/gx-77/resume.pdf'), applicationPdf('Backend Engineer', 'Globex Corporation'))
// The `mocks` workspace (#49): applications whose posting URLs point at the e2e mock server. `no-resume-mock` has none on purpose.
for (const [folder, company] of [
  ['lever-mock/lv-1', 'Acme'],
  ['greenhouse-mock/gh-1', 'Acme'],
  ['generic-mock/gen-1', 'Example Co'],
  ['applied-mock/ap-1', 'Acme'],
  ['redirect-mock/rd-1', 'Acme']
]) {
  await write(join(here, `workspaces/mocks/software-engineer/${folder}/resume.pdf`), applicationPdf('Software Engineer', company))
}
await write(join(here, 'workspaces/mocks/software-engineer/generic-mock/gen-1/cover.pdf'), coverPdf('Example Co'))
