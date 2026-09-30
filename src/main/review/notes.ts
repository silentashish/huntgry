import { createHash } from 'node:crypto'
import type { ProposedReframing, ReviewNotes } from '@shared/review-types'

/**
 * `review-notes.md`, written by an unattended run in the application folder
 * and parsed here (pure). The format the prompt asks for:
 *
 * ```markdown
 * # Review notes
 * <!-- huntgry-review v1 · run <run id> · unattended -->
 *
 * ## Used standing approvals
 * - Source fact: <verbatim>
 *   Wording: <as written in the resume>
 *
 * ## Proposed reframings (not used)
 * ### R1 · <requirement from the job description>
 * - Source fact: <verbatim sentence or bullet from master-profile.md>
 * - Proposed wording: <the bullet you would have written, ≤ 120 chars>
 * - Why unsure: <one line>
 *
 * ## Open gaps
 * - <requirement>: nothing honest to say
 *
 * ## Notes
 * <anything else the user should know>
 * ```
 *
 * Tolerant of heading case and order, `-` or `*` bullets and missing sections.
 * Reframing ids are `sha256(sourceFact + "\n" + wording)` after trimming and
 * collapsing inner whitespace, so the desktop and the phone (#42) agree on them.
 */

/** Whitespace-normalised text, the basis of every reframing id. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function reframingId(sourceFact: string, wording: string): string {
  return createHash('sha256').update(`${normalizeText(sourceFact)}\n${normalizeText(wording)}`).digest('hex')
}

type Section = 'used' | 'proposed' | 'gaps' | 'notes' | 'other'

function sectionOf(heading: string): Section {
  const h = heading.toLowerCase()
  if (/standing approval|used approval|approvals used/.test(h)) return 'used'
  if (/proposed|reframing|not used/.test(h)) return 'proposed'
  if (/open gap|gaps/.test(h)) return 'gaps'
  if (/^notes?\b/.test(h)) return 'notes'
  return 'other'
}

const FIELD = /^(?:[-*]\s*)?(source fact|proposed wording|wording|why unsure|reason|requirement)\s*:\s*(.*)$/i
const BULLET = /^[-*]\s+(.*)$/

interface Pair {
  requirement?: string
  sourceFact?: string
  wording?: string
  reason?: string
}

/** Groups "Source fact / Wording / Why unsure" lines into entries; a new "Source fact" starts a new one. */
function collectPairs(lines: string[]): Pair[] {
  const pairs: Pair[] = []
  let current: Pair | null = null
  let requirement: string | undefined
  let lastField: keyof Pair | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const sub = /^#{3,6}\s+(.*)$/.exec(line)
    if (sub) {
      // "R1 · <requirement>" or just the requirement.
      requirement = normalizeText(sub[1].replace(/^R?\d+\s*[·:.)-]\s*/i, ''))
      current = null
      lastField = null
      continue
    }
    const m = FIELD.exec(line)
    if (m) {
      const key = m[1].toLowerCase()
      const value = m[2].trim()
      if (key === 'source fact') {
        current = { requirement }
        pairs.push(current)
        current.sourceFact = value
        lastField = 'sourceFact'
      } else if (!current) {
        continue
      } else if (key === 'wording' || key === 'proposed wording') {
        current.wording = value
        lastField = 'wording'
      } else if (key === 'requirement') {
        current.requirement = value
        lastField = 'requirement'
      } else {
        current.reason = value
        lastField = 'reason'
      }
      continue
    }
    // A wrapped continuation of the previous field (indented or not, no bullet marker).
    if (current && lastField && !BULLET.test(line)) current[lastField] = `${current[lastField] ?? ''} ${line}`.trim()
  }
  return pairs
}

export function parseReviewNotes(markdown: string): ReviewNotes {
  const notes: ReviewNotes = { usedApprovals: [], proposed: [], openGaps: [], notes: '' }
  const runMatch = /huntgry-review\s+v\d+\s*·\s*run\s+([\w-]+)/i.exec(markdown)
  if (runMatch) notes.runId = runMatch[1]

  const sections = new Map<Section, string[]>()
  let current: Section = 'other'
  let sawHeading = false
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line.trim())
    if (h) {
      current = sectionOf(h[1])
      sawHeading = sawHeading || current !== 'other'
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (!sections.has(current)) sections.set(current, [])
    sections.get(current)!.push(line)
  }

  for (const p of collectPairs(sections.get('used') ?? [])) {
    if (p.sourceFact && p.wording) notes.usedApprovals.push({ sourceFact: p.sourceFact, wording: p.wording })
  }
  for (const p of collectPairs(sections.get('proposed') ?? [])) {
    if (!p.sourceFact || !p.wording) continue
    const r: ProposedReframing = { id: reframingId(p.sourceFact, p.wording), sourceFact: p.sourceFact, wording: p.wording }
    if (p.requirement) r.requirement = p.requirement
    if (p.reason) r.reason = p.reason
    notes.proposed.push(r)
  }
  for (const raw of sections.get('gaps') ?? []) {
    const m = BULLET.exec(raw.trim())
    if (m && m[1].trim()) notes.openGaps.push(normalizeText(m[1]))
  }
  notes.notes = (sections.get('notes') ?? []).join('\n').trim()

  if (!sawHeading) {
    notes.parseWarning = 'review-notes.md does not follow the expected format; the raw notes are shown instead.'
  } else if (notes.proposed.length === 0 && sections.has('proposed')) {
    const body = (sections.get('proposed') ?? []).join('\n').trim()
    if (body && !/^(none|nothing|-\s*none)/i.test(body))
      notes.parseWarning = 'The proposed reframings could not be read; approve from the raw notes, nothing can be saved as a standing approval.'
  }
  return notes
}
