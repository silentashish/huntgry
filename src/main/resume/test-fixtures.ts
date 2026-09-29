import { crc32, deflateRawSync } from 'node:zlib'

/**
 * Builders for the resume tests: a real (minimal) .docx and .pdf, generated in
 * memory so no binary fixture, and no real person's resume, is committed.
 */

export interface DocxParagraph {
  runs: Array<string | { tab: true } | { link: string; text: string }>
  bullet?: boolean
}

export function buildDocx(paragraphs: DocxParagraph[], header: DocxParagraph[] = []): Buffer {
  const rels: string[] = []
  const para = (p: DocxParagraph): string => {
    const props = p.bullet ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : ''
    const runs = p.runs
      .map((r) => {
        if (typeof r === 'string') return `<w:r><w:t xml:space="preserve">${xml(r)}</w:t></w:r>`
        if ('tab' in r) return '<w:r><w:tab/></w:r>'
        const id = `rId${rels.length + 10}`
        rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(r.link)}" TargetMode="External"/>`)
        return `<w:hyperlink r:id="${id}"><w:r><w:t>${xml(r.text)}</w:t></w:r></w:hyperlink>`
      })
      .join('')
    return `<w:p>${props}${runs}</w:p>`
  }
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const body = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${paragraphs.map(para).join('')}<w:sectPr/></w:body></w:document>`
  const bodyRels = rels.splice(0)
  const head = `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${ns}>${header.map(para).join('')}</w:hdr>`
  const relsXml = (list: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join('')}</Relationships>`
  return buildZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', false],
    ['word/document.xml', body, true],
    ['word/_rels/document.xml.rels', relsXml(bodyRels), true],
    ['word/header1.xml', head, false],
    ['word/_rels/header1.xml.rels', relsXml(rels), false]
  ])
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** ZIP with one entry per [name, content, deflate?]. */
export function buildZip(files: Array<[string, string | Buffer, boolean]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content, deflate] of files) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const data = deflate ? deflateRawSync(raw) : raw
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

export interface PdfText {
  x: number
  y: number
  text: string
  size?: number
}

/**
 * One-page PDF with Helvetica text at fixed positions and URI link annotations.
 * Text is WinAnsi-encoded, so "•" and "–" come out as real glyphs.
 */
export function buildPdf(texts: PdfText[], links: Array<{ rect: [number, number, number, number]; url: string }> = []): Buffer {
  const winAnsi: Record<string, number> = { '•': 0x95, '–': 0x96, '—': 0x97, '’': 0x92 }
  const encode = (s: string) =>
    Array.from(s)
      .map((ch) => {
        const code = winAnsi[ch] ?? ch.charCodeAt(0)
        if (ch === '(' || ch === ')' || ch === '\\') return '\\' + ch
        return code > 126 ? '\\' + code.toString(8).padStart(3, '0') : ch
      })
      .join('')
  const stream = texts
    .map((t) => `BT /F1 ${t.size ?? 10} Tf 1 0 0 1 ${t.x} ${t.y} Tm (${encode(t.text)}) Tj ET`)
    .join('\n')
  const annotIds = links.map((_l, i) => 6 + i)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R${
      annotIds.length ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(' ')}]` : ''
    } >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    ...links.map((l) => `<< /Type /Annot /Subtype /Link /Rect [${l.rect.join(' ')}] /Border [0 0 0] /A << /S /URI /URI (${l.url}) >> >>`)
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
