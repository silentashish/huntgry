import type { ResumeLine } from './types'
import { listZip, readZipEntry, ZipError, type ZipEntry } from './zip'

/**
 * Reads the text of a .docx as lines: one per paragraph, tabs kept (resumes
 * use them to push dates and locations to the right margin), list paragraphs
 * flagged as bullets, and hyperlink targets attached to their line.
 * Headers come first because many templates keep the name and contact there.
 */
export function extractDocx(buf: Buffer): ResumeLine[] {
  const entries = listZip(buf)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const body = byName.get('word/document.xml')
  if (!body) throw new ZipError('Not a Word document (word/document.xml is missing).')

  const lines: ResumeLine[] = []
  const headers = entries.filter((e) => /^word\/header\d*\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))
  for (const part of [...headers, body]) {
    const rels = readRels(buf, byName.get(part.name.replace(/^word\//, 'word/_rels/') + '.rels'))
    lines.push(...paragraphs(readZipEntry(buf, part).toString('utf8'), rels))
  }
  return lines
}

function readRels(buf: Buffer, entry: ZipEntry | undefined): Map<string, string> {
  const rels = new Map<string, string>()
  if (!entry) return rels
  const xml = readZipEntry(buf, entry).toString('utf8')
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1]
    if (id && target && /TargetMode="External"/.test(m[1])) rels.set(id, decodeXml(target))
  }
  return rels
}

const TOKEN_RE =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<w:hyperlink\b[^>]*\br:id="([^"]*)"|<w:instrText(?:\s[^>]*)?>([\s\S]*?)<\/w:instrText>/g

function paragraphs(xml: string, rels: Map<string, string>): ResumeLine[] {
  const out: ResumeLine[] = []
  for (const m of xml.matchAll(/<w:p(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = m[2] ?? ''
    const props = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(inner)?.[1] ?? ''
    const bullet = /<w:numPr>/.test(props) || /<w:pStyle w:val="List(?:Bullet|Number|Paragraph)/i.test(props)
    let text = ''
    const links: string[] = []
    for (const t of inner.matchAll(TOKEN_RE)) {
      if (t[1] !== undefined) text += decodeXml(t[1])
      else if (t[2] === 'tab') text += '\t'
      else if (t[2]) text += '\n'
      else if (t[3]) {
        const url = rels.get(t[3])
        if (url) links.push(url)
      } else if (t[4]) {
        const url = /HYPERLINK\s+"([^"]+)"/.exec(decodeXml(t[4]))?.[1]
        if (url) links.push(url)
      }
    }
    // A manual line break splits the paragraph; only its first line keeps the bullet.
    text.split('\n').forEach((part, i) => {
      if (part.trim()) out.push({ text: part.replace(/\s+$/, ''), bullet: bullet && i === 0, links: i === 0 ? links : [] })
    })
  }
  return out
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, code: string) => {
    switch (code.toLowerCase()) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
    }
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
  })
}
