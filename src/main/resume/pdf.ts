import { extractTextItems, getDocumentProxy, type StructuredTextItem } from 'unpdf'
import type { ResumeLine } from './types'

/** Bullet glyphs seen in exported resumes, including Symbol/Wingdings private-use code points. */
const BULLET_RE = /^[•●▪◦‣∙·■□➢►▸*–-]\s*/

const MAX_PAGES = 20

interface Row {
  y: number
  items: StructuredTextItem[]
}

/**
 * Rebuilds visual lines from positioned text: items on the same baseline are
 * joined left to right, a wide horizontal gap becomes a tab (the right-aligned
 * date column), a leading bullet glyph marks a list item, and a wrapped
 * continuation of a bullet is merged back into it. Link annotations are
 * attached to the line they sit on.
 */
export async function extractPdf(buf: Buffer): Promise<ResumeLine[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  try {
    const { items } = await extractTextItems(pdf)
    const lines: ResumeLine[] = []
    for (let p = 0; p < Math.min(items.length, MAX_PAGES); p++) {
      const page = await pdf.getPage(p + 1)
      const annotations: Array<{ subtype?: string; url?: string; rect?: number[] }> = await page.getAnnotations()
      const links = annotations
        .filter((a) => a.subtype === 'Link' && typeof a.url === 'string' && Array.isArray(a.rect))
        .map((a) => ({ url: a.url as string, y1: Math.min(a.rect![1], a.rect![3]), y2: Math.max(a.rect![1], a.rect![3]) }))
      lines.push(...pageLines(items[p], links))
    }
    return lines
  } finally {
    await pdf.loadingTask.destroy()
  }
}

interface VisualRow {
  text: string
  x: number
  end: number
  links: string[]
  /** Starts with a bullet glyph; `textX` is where the text after it begins. */
  glyph: boolean
  textX: number
}

function pageLines(items: StructuredTextItem[], links: Array<{ url: string; y1: number; y2: number }>): ResumeLine[] {
  const rows: Row[] = []
  for (const item of items) {
    if (!item.str) continue
    const tolerance = Math.max(2, (item.fontSize || 10) * 0.4)
    const row = rows.find((r) => Math.abs(r.y - item.y) <= tolerance)
    if (row) row.items.push(item)
    else rows.push({ y: item.y, items: [item] })
  }
  rows.sort((a, b) => b.y - a.y)

  const visual: VisualRow[] = []
  for (const row of rows) {
    const items = row.items.filter((i) => i.str.trim()).sort((a, b) => a.x - b.x)
    if (!items.length) continue
    let text = ''
    let prev: StructuredTextItem | null = null
    for (const item of items) {
      if (prev) {
        // Whitespace items were dropped, so the gap measures the real distance between words.
        const gap = item.x - (prev.x + prev.width)
        const size = item.fontSize || 10
        if (gap > size * 0.9) text += '\t'
        else if (gap > size * 0.15) text += ' '
      }
      text += item.str
      prev = item
    }
    text = text.replace(/[ \u00a0]+/g, ' ').trim()
    const glyph = BULLET_RE.exec(text)
    const textX = glyph && glyph[0].length >= items[0].str.trim().length && items[1] ? items[1].x : items[0].x
    visual.push({
      text: glyph ? text.slice(glyph[0].length) : text,
      x: items[0].x,
      end: prev!.x + prev!.width,
      links: links.filter((l) => row.y >= l.y1 - 2 && row.y <= l.y2 + 2).map((l) => l.url),
      glyph: Boolean(glyph),
      textX
    })
  }
  if (!visual.length) return []

  // Without bullet glyphs (some exporters draw them as graphics), an indented,
  // left-aligned row is taken as a list item. Centred rows (name, contact line) are not.
  const margin = Math.min(...visual.map((r) => r.x))
  const right = Math.max(...visual.map((r) => r.end))
  const hasGlyphs = visual.some((r) => r.glyph)
  const indented = (r: VisualRow): boolean => {
    const left = r.x - margin
    const centred = left > 40 && Math.abs(left - (right - r.end)) < 20
    return left >= 8 && left <= 60 && !centred
  }

  const out: ResumeLine[] = []
  let bulletX: number | null = null
  for (const r of visual) {
    const last = out[out.length - 1]
    const aligned = bulletX !== null && Math.abs(r.x - bulletX) <= 3
    if (r.glyph) {
      out.push({ text: r.text, bullet: true, links: r.links })
      bulletX = r.textX
      continue
    }
    if (last?.bullet && aligned && !r.text.includes('\t')) {
      // Glyph bullets: any row at the text indent continues the item. Inferred
      // bullets: only when the text clearly runs on (lower-case start or no full stop).
      const runsOn = /^[\p{Ll}(]/u.test(r.text) || (!/[.!?:)]$/.test(last.text) && !/^[^:]{1,40}:\s/.test(r.text))
      if (hasGlyphs || runsOn) {
        last.text += (/-$/.test(last.text) ? '' : ' ') + r.text
        last.links.push(...r.links)
        continue
      }
    }
    const bullet = !hasGlyphs && indented(r) && !r.text.includes('\t')
    bulletX = bullet ? r.x : null
    out.push({ text: r.text, bullet, links: r.links })
  }
  return out
}
