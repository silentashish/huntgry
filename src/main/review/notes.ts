import { createHash } from 'node:crypto'
import { NOTES_V2_MARKER, type ProposedReframing, type ReviewNotes } from '@shared/review-types'

/**
 * The notes a run leaves next to the resume, parsed here (pure).
 *
 * `tailoring-notes.md` v2 (#158), written by resume-tailor v5 (and by v4 when
 * the prompt describes it) and copied into the folder by `build.py --notes`:
 *
 * ```markdown
 * # Tailoring notes
 * <!-- resume-tailor notes v2 -->
 *
 * ## Direct hits
 * - <requirement>: <profile evidence>
 *
 * ## Reframings used
 * ### <requirement from the posting>
 * - Source fact: <verbatim sentence or bullet from the master profile>
 * - Wording: <as written in the resume>
 *
 * ## Gaps left open
 * - <requirement>: <why nothing honest fits>
 *
 * ## Decisions
 * - <date style and why, bullets cut or trimmed, judgement calls on honesty>
 * ```
 *
 * `review-notes.md` v1, written by an unattended run before #158 (older
 * results still carry it):
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

/** The lines under each `## ` heading, keyed by `sectionOf(heading)`; `sawHeading` when one was known. */
function splitSections<S extends string>(
  markdown: string,
  sectionOf: (heading: string) => S | 'other'
): { sections: Map<S | 'other', string[]>; sawHeading: boolean } {
  const sections = new Map<S | 'other', string[]>()
  let current: S | 'other' = 'other'
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
  return { sections, sawHeading }
}

const NONE = /^(none|nothing|-\s*none)/i

function emptyNotes(format: ReviewNotes['format']): ReviewNotes {
  return { format, usedApprovals: [], proposed: [], directHits: [], reframingsUsed: [], openGaps: [], decisions: [], notes: '' }
}

/** Source fact → wording entries with their ids (entries missing either are dropped). */
function reframingsOf(lines: string[]): ProposedReframing[] {
  const out: ProposedReframing[] = []
  for (const p of collectPairs(lines)) {
    if (!p.sourceFact || !p.wording) continue
    const r: ProposedReframing = { id: reframingId(p.sourceFact, p.wording), sourceFact: p.sourceFact, wording: p.wording }
    if (p.requirement) r.requirement = p.requirement
    if (p.reason) r.reason = p.reason
    out.push(r)
  }
  return out
}

/** One entry per bullet, wrapped lines joined, "None." skipped. */
function bulletsOf(lines: string[]): string[] {
  const out: string[] = []
  let open = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      open = false
      continue
    }
    const m = BULLET.exec(line)
    if (m) {
      const text = normalizeText(m[1])
      open = Boolean(text) && !NONE.test(text)
      if (open) out.push(text)
    } else if (open) {
      out[out.length - 1] = `${out[out.length - 1]} ${normalizeText(line)}`
    }
  }
  return out
}

export function parseReviewNotes(markdown: string): ReviewNotes {
  const notes = emptyNotes('v1')
  const runMatch = /huntgry-review\s+v\d+\s*·\s*run\s+([\w-]+)/i.exec(markdown)
  if (runMatch) notes.runId = runMatch[1]

  const { sections, sawHeading } = splitSections(markdown, sectionOf)

  for (const p of collectPairs(sections.get('used') ?? [])) {
    if (p.sourceFact && p.wording) notes.usedApprovals.push({ sourceFact: p.sourceFact, wording: p.wording })
  }
  notes.proposed = reframingsOf(sections.get('proposed') ?? [])
  for (const raw of sections.get('gaps') ?? []) {
    const m = BULLET.exec(raw.trim())
    if (m && m[1].trim()) notes.openGaps.push(normalizeText(m[1]))
  }
  notes.notes = (sections.get('notes') ?? []).join('\n').trim()

  if (!sawHeading) {
    notes.parseWarning = 'review-notes.md does not follow the expected format; the raw notes are shown instead.'
  } else if (notes.proposed.length === 0 && sections.has('proposed')) {
    const body = (sections.get('proposed') ?? []).join('\n').trim()
    if (body && !NONE.test(body))
      notes.parseWarning = 'The proposed reframings could not be read; approve from the raw notes, nothing can be saved as a standing approval.'
  }
  return notes
}

type SectionV2 = 'hits' | 'used' | 'gaps' | 'decisions'

function sectionV2Of(heading: string): SectionV2 | 'other' {
  const h = heading.toLowerCase()
  if (/direct hit/.test(h)) return 'hits'
  if (/reframing/.test(h)) return 'used'
  if (/gap/.test(h)) return 'gaps'
  if (/decision/.test(h)) return 'decisions'
  return 'other'
}

export function isNotesV2(markdown: string): boolean {
  return markdown.includes(NOTES_V2_MARKER)
}

/**
 * `tailoring-notes.md` v2. A file without the marker (free-form notes of an older attended run, or
 * a run that ignored the format) yields nothing but a warning: no reframing from it can be ticked.
 */
export function parseTailoringNotes(markdown: string): ReviewNotes {
  const notes = emptyNotes('v2')
  if (!isNotesV2(markdown)) {
    notes.parseWarning = 'tailoring-notes.md is not in the v2 format (resume-tailor notes v2); the raw notes are shown instead.'
    return notes
  }
  const { sections, sawHeading } = splitSections(markdown, sectionV2Of)
  notes.directHits = bulletsOf(sections.get('hits') ?? [])
  notes.reframingsUsed = reframingsOf(sections.get('used') ?? [])
  notes.openGaps = bulletsOf(sections.get('gaps') ?? [])
  notes.decisions = bulletsOf(sections.get('decisions') ?? [])
  if (!sawHeading) {
    notes.parseWarning = 'tailoring-notes.md has none of the v2 sections; the raw notes are shown instead.'
  } else if (notes.reframingsUsed.length === 0 && sections.has('used')) {
    const body = (sections.get('used') ?? []).join('\n').trim()
    if (body && !NONE.test(body))
      notes.parseWarning = 'The reframings used could not be read; approve from the raw notes, nothing can be saved as a standing approval.'
  }
  return notes
}
