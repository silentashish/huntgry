import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { extractDocx } from './docx'
import { extractPdf } from './pdf'
import type { ResumeLine } from './types'

export const RESUME_EXTENSIONS = ['docx', 'pdf', 'txt', 'md'] as const

const MAX_RESUME_BYTES = 20 * 1024 * 1024

export class ResumeReadError extends Error {}

/** Reads a resume file into lines. Format is chosen by content (magic bytes), then extension. */
export async function readResumeLines(path: string): Promise<ResumeLine[]> {
  const info = await stat(path)
  if (!info.isFile()) throw new ResumeReadError('That is not a file.')
  if (info.size > MAX_RESUME_BYTES) throw new ResumeReadError('The file is larger than 20 MB.')
  const buf = await readFile(path)
  const ext = extname(path).slice(1).toLowerCase()

  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return extractPdf(buf)
  if (buf.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004') {
    if (ext !== 'docx' && ext !== '') throw new ResumeReadError(`.${ext} files are not supported.`)
    return extractDocx(buf)
  }
  if (ext === 'doc') throw new ResumeReadError('Old .doc files are not supported. Save the resume as .docx or PDF.')
  if (ext === 'docx' || ext === 'pdf') throw new ResumeReadError(`The file does not look like a valid .${ext}.`)
  if (buf.includes(0)) throw new ResumeReadError('Unsupported file type. Use .docx, .pdf, .txt or .md.')
  return textLines(buf.toString('utf8'))
}

/** Plain text and Markdown: `#` heading marks, emphasis and bullet markers are removed. */
export function textLines(text: string): ResumeLine[] {
  const out: ResumeLine[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) continue
    const bullet = /^\s*(?:[-*+•]|\d+[.)])\s+/.exec(raw)
    const links: string[] = []
    let line = (bullet ? raw.slice(bullet[0].length) : raw)
      .replace(/^#{1,6}\s+/, '')
      // [text](url) → text, keeping the URL as a link.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
        links.push(url)
        return label
      })
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .trimEnd()
    line = line.replace(/ {3,}/g, '\t')
    out.push({ text: line, bullet: Boolean(bullet), links })
  }
  return out
}
