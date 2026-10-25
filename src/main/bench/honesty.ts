import type { ProposedReframing } from '@shared/review-types'
import type { Untraceable, UntraceableKind } from './types'

/**
 * Claims of a tailored resume that the master profile does not back: the benchmark's honesty count (#152).
 * Deterministic and cheap. It is a **regression signal**: compare the count between two bench runs of the same
 * set and profile, don't read it as an absolute truth. A resume that rephrases a number ("4 million" vs "4M" is
 * handled, "doubled" vs "2x" is not) or shortens a title can be flagged although it is honest.
 *
 * - `unbacked`: requirements the resume shows and the profile has no evidence for (`resumeCoverage().unbacked`, #151).
 * - `reframing`: a reframing in `tailoring-notes.md` whose source fact is not in the profile.
 * - `number`: a number in the resume's summary or bullets that the profile never states (years are left out).
 * - `identity`: an employer, title, school, degree or certification the profile does not name.
 */

/** Most items `Untraceable.items` keeps; the count covers them all. */
export const MAX_UNTRACEABLE_ITEMS = 20
/** Share of a source fact's words one profile line must have for the fact to count as quoted from it. */
const FACT_OVERLAP = 0.9

/** Lowercase words and numbers only: "B.S. in C.S." and "b s in c s" read the same. */
export function looseText(s: string): string {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function words(s: string): string[] {
  return looseText(s).split(' ').filter(Boolean)
}

/** Whether the profile names `text` word for word (case, punctuation and spacing aside). */
export function profileStates(profile: string, text: string): boolean {
  const want = looseText(text)
  return !want || ` ${looseText(profile)} `.includes(` ${want} `)
}

/**
 * Whether the profile states a reframing's source fact: word for word, or one profile line has nearly all its
 * words (the notes may quote a bullet without its trailing clause or with other punctuation).
 */
export function profileHasFact(profile: string, fact: string): boolean {
  if (profileStates(profile, fact)) return true
  const factWords = [...new Set(words(fact))]
  return profile.split('\n').some((line) => {
    const have = new Set(words(line))
    return factWords.filter((w) => have.has(w)).length / factWords.length >= FACT_OVERLAP
  })
}

const MULTIPLIER: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }
const NUMBER = /(?<![\p{L}\p{N}_.])\$?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*(%|percent\b|k\b|m\b|b\b|bn\b|thousand\b|million\b|billion\b|x\b))?/giu

/**
 * The numbers a text states, as canonical strings: `4M`, `4 million` and `4,000,000` are all `4000000`, `40%`
 * is `40`. Bare years (1900–2099) are left out: dates are the profile's, and a resume repeats them.
 */
export function numbersIn(text: string): { raw: string; value: string }[] {
  const out: { raw: string; value: string }[] = []
  for (const m of text.matchAll(NUMBER)) {
    const n = Number(m[1].replace(/,/g, ''))
    const unit = m[2]?.toLowerCase()
    if (!unit && /^\d{4}$/.test(m[1]) && n >= 1900 && n <= 2099) continue
    const value = n * (unit ? (MULTIPLIER[unit] ?? 1) : 1)
    out.push({ raw: m[0].trim(), value: String(Number(value.toPrecision(12))) })
  }
  return out
}

/** The parts of the skill's `resume_data.json` the checks read. */
interface ResumeData {
  summary?: unknown
  experience?: unknown
  projects?: unknown
  education?: unknown
  certifications?: unknown
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []

/** The resume's sentences that may carry numbers: summary, role and project bullets. */
function claimTexts(data: ResumeData): string[] {
  return [
    str(data.summary),
    ...list(data.experience).flatMap((e) => (Array.isArray(e.bullets) ? e.bullets.map(str) : [])),
    ...list(data.projects).flatMap((p) => (Array.isArray(p.bullets) ? p.bullets.map(str) : []))
  ].filter((t) => t.trim())
}

/** Employers, titles, schools, degrees and certifications the resume names. */
function identityFacts(data: ResumeData): string[] {
  return [
    ...list(data.experience).flatMap((e) => [str(e.company), str(e.title)]),
    ...list(data.education).flatMap((e) => [str(e.institution), str(e.degree)]),
    ...list(data.certifications).map((c) => str(c.name))
  ].filter((t) => t.trim())
}

export interface HonestyInputs {
  /** The master profile's Markdown. */
  profile: string
  /** `resumeCoverage().unbacked` skill names (from `scoreApplication`); empty when the run was not scored. */
  unbacked: readonly string[]
  /** `tailoring-notes.md` → reframings used. */
  reframings: readonly Pick<ProposedReframing, 'sourceFact'>[]
  /** The parsed `resume_data.json`, or `null` when there is none. */
  resumeData: unknown
}

export function untraceableClaims(inputs: HonestyInputs): Untraceable {
  const found: { kind: UntraceableKind; text: string }[] = []
  for (const skill of inputs.unbacked) found.push({ kind: 'unbacked', text: skill })
  for (const r of inputs.reframings) {
    if (!profileHasFact(inputs.profile, r.sourceFact)) found.push({ kind: 'reframing', text: r.sourceFact })
  }
  const data = (typeof inputs.resumeData === 'object' && inputs.resumeData !== null ? inputs.resumeData : {}) as ResumeData
  const known = new Set(numbersIn(inputs.profile).map((n) => n.value))
  const seen = new Set<string>()
  for (const text of claimTexts(data)) {
    for (const n of numbersIn(text)) {
      if (known.has(n.value) || seen.has(n.value)) continue
      seen.add(n.value)
      found.push({ kind: 'number', text: `${n.raw} (${text.trim().slice(0, 80)})` })
    }
  }
  for (const fact of new Set(identityFacts(data))) {
    if (!profileStates(inputs.profile, fact)) found.push({ kind: 'identity', text: fact })
  }
  const byKind: Record<UntraceableKind, number> = { unbacked: 0, reframing: 0, number: 0, identity: 0 }
  for (const f of found) byKind[f.kind]++
  return { count: found.length, byKind, items: found.slice(0, MAX_UNTRACEABLE_ITEMS) }
}
