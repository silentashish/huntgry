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

/** A generated application's `cover.pdf`: one page, one paragraph. */
function coverPdf(role: string, company: string): Buffer {
  return buildPdf([
    { x: 56, y: 740, text: 'Alex Rivera', size: 16 },
    { x: 56, y: 710, text: `Dear ${company} hiring team,` },
    { x: 56, y: 690, text: `I am applying for the ${role} position.` },
    { x: 56, y: 660, text: 'Alex' }
  ])
}

/**
 * The page previews the skill renders next to a PDF (`resume-page-1.jpg`):
 * a baseline JPEG built from scratch, grayscale, one 8×8 block per cell of
 * `shade(bx, by)`, no AC coefficients. Custom Huffman tables cover only the
 * DC categories used, so the file is a few hundred bytes and decodes in any
 * browser. `width`/`height` are what the decoder reports (naturalWidth/Height).
 */
export function buildJpeg(width: number, height: number, shade: (bx: number, by: number) => number): Buffer {
  const cols = Math.ceil(width / 8)
  const rows = Math.ceil(height / 8)
  // Quantized DC of a flat block of value v is (v - 128) with an all-8 quantization table.
  const dcs: number[] = []
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) dcs.push(Math.max(0, Math.min(255, Math.round(shade(bx, by)))) - 128)
  const diffs = dcs.map((dc, i) => dc - (i === 0 ? 0 : dcs[i - 1]))
  const category = (v: number) => (v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v))) + 1)
  const categories = [...new Set(diffs.map(category))].sort((a, b) => a - b)

  // One Huffman code length for every symbol, chosen so that no code is all ones (reserved by the format).
  const length = Math.max(1, Math.ceil(Math.log2(categories.length + 1)))
  const codes = new Map(categories.map((c, i) => [c, { code: i, length }]))
  const dht = (tableClass: number, symbols: number[], codeLength: number): Buffer => {
    const bits = Buffer.alloc(16)
    bits[codeLength - 1] = symbols.length
    const body = Buffer.concat([Buffer.from([(tableClass << 4) | 0]), bits, Buffer.from(symbols)])
    return Buffer.concat([Buffer.from([0xff, 0xc4, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body])
  }

  // Entropy-coded segment: per block the DC difference (Huffman code + extra bits) then the AC end-of-block.
  const bits: number[] = []
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  for (const diff of diffs) {
    const cat = category(diff)
    const { code, length: len } = codes.get(cat)!
    push(code, len)
    if (cat > 0) push(diff > 0 ? diff : diff + (1 << cat) - 1, cat)
    push(0, 1) // AC table has a single symbol (0x00 = EOB), coded as one 0 bit.
  }
  while (bits.length % 8 !== 0) bits.push(1)
  const scan: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    const byte = bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0)
    scan.push(byte)
    if (byte === 0xff) scan.push(0x00)
  }

  const segment = (marker: number, body: number[]) => Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]), // JFIF, no thumbnail
    segment(0xdb, [0x00, ...new Array<number>(64).fill(8)]),
    segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
    dht(0, categories, length),
    dht(1, [0x00], 1),
    segment(0xda, [1, 1, 0x00, 0, 63, 0]),
    Buffer.from(scan),
    Buffer.from([0xff, 0xd9])
  ])
}

/** A page preview: a light page with a dark title band and a few grey "text" rows. */
function pagePreview(kind: 'resume' | 'cover'): Buffer {
  return buildJpeg(96, 124, (bx, by) => {
    if (by === 1) return 40 // title band
    if (kind === 'resume' && by >= 4 && by % 2 === 0 && bx >= 1 && bx <= 10) return 150
    if (kind === 'cover' && by >= 4 && by <= 9 && bx >= 1 && bx <= 10) return 170
    return 235
  })
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
// #47: an interviewing application with a cover letter and page previews, and a rejected one with a resume but no posting URL.
const initech = join(here, 'workspaces/demo/platform-engineer/initech/init-9')
await write(join(initech, 'resume.pdf'), applicationPdf('Platform Engineer', 'Initech'))
await write(join(initech, 'cover.pdf'), coverPdf('Platform Engineer', 'Initech'))
await write(join(initech, 'resume-page-1.jpg'), pagePreview('resume'))
await write(join(initech, 'cover-page-1.jpg'), pagePreview('cover'))
await write(join(here, 'workspaces/demo/frontend-engineer/wayne/wy-3/resume.pdf'), applicationPdf('Frontend Engineer', 'Wayne Enterprises'))
