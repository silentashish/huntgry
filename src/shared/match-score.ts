import { requiresClearance, sponsorshipOf } from './job-filters'
import type { Job } from './jobs-types'
import { displaySkill, mentions, mentionsAffirmatively, normalizeSkill, skillKey, SLASH_NAMES, TECH_VOCABULARY } from './skills'

/**
 * Match score (#149): how much of what a job asks for the master profile has evidence for, out of 100.
 * The shared engine behind the Jobs page's Relevant skills part (#73), Explore (#150), the re-score after
 * tailoring (#151) and Automation (#154). Local and deterministic: no model call, no I/O.
 *
 * 1. **Requirements**, best source first: Jobright's `jdCoreSkills` (already extracted and weighted), else
 *    the skills the description names, looked up with the profile's own skills plus `TECH_VOCABULARY`, so
 *    a technology the profile lacks still counts against it.
 * 2. **Coverage** = Σ weight of the requirements the profile has evidence for ÷ Σ weight of all × 100.
 * 3. **Gates**: must-haves (degree field, PhD, minimum years, clearance, "no sponsorship" for someone who
 *    needs it) are not points. A failed gate caps the score at `GATE_CAP` and says why.
 */

/** One entry of a Jobright posting's `jdCoreSkills`: `{ "skill": "Data Analysis", "score": 3, "type": "hard_skill" }`. */
export interface JobrightSkill {
  skill: string
  /** Jobright's importance, 1 (minor) to 3 (core). */
  score: number
  /** `hard_skill` or `soft_skill`; anything else is read as a hard skill. */
  type: 'hard_skill' | 'soft_skill' | (string & {})
}

/**
 * What `matchScore` reads from a job: a saved `Job` fits, and so does any object with a title and a
 * description (an Explore row once its posting is loaded, #150). `jdCoreSkills` wins over the description.
 */
export type MatchJob = Pick<Job, 'title' | 'description'> &
  Partial<Pick<Job, 'tags' | 'minYearsExperience' | 'visaSponsorship'>> & {
    jdCoreSkills?: readonly JobrightSkill[] | null
  }

/** A degree of the profile, as `profileSignals` reads it from the Education section. */
export interface ProfileDegree {
  /** e.g. `Master of Science`. */
  degree: string
  /** e.g. `Computer Science`. */
  field: string
}

/**
 * What `matchScore` reads from the profile: `profileSignals(profile)` (`job-relevance.ts`) gives all of it.
 * `degrees` and `evidence` are optional so a caller with only skill names can still score; without them the
 * degree gates pass and evidence comes from `skills` alone.
 */
export interface MatchProfile {
  /** Skill names the profile has evidence for (knowledge graph, gaps excluded). */
  skills: readonly string[]
  /** Years of experience, overlaps counted once. */
  years: number
  needsSponsorship: boolean
  degrees?: readonly ProfileDegree[]
  /**
   * The profile's own words (skills lines with their annotations, technologies, highlights, summary,
   * education, certifications), never its "Gaps & notes": a requirement written there affirmatively counts
   * as evidence ("Data Analysis", "EC2" inside "AWS (EC2, S3)").
   */
  evidence?: string
}

/** Where the requirements came from. */
export type MatchSource = 'jobright-skills' | 'description'

/** One requirement of the job. */
export interface MatchSkill {
  /** Display name (`Kubernetes` for `k8s`). */
  skill: string
  /** Its weight in the score: Jobright's score (soft skills × `SOFT_SKILL_WEIGHT`), or 1 / `PREFERRED_WEIGHT`. */
  weight: number
  soft: boolean
}

export type GateKind = 'degree' | 'years' | 'clearance' | 'sponsorship'

/** A must-have the profile does not meet. */
export interface MatchGate {
  kind: GateKind
  /** Why, for the UI: "Asks for 5+ years of experience (you have 2)". */
  reason: string
}

export interface MatchResult {
  /**
   * 0–100 integer: the weighted share of requirements matched, capped at `GATE_CAP` when a gate failed.
   * 0 when the job names no requirement at all (`matched` and `missing` both empty): unknown, not a mismatch.
   */
  score: number
  /** Requirements the profile has evidence for, heaviest first. */
  matched: MatchSkill[]
  /** Requirements it lacks, heaviest first. */
  missing: MatchSkill[]
  /** Failed must-haves; empty when every gate passed or could not be read. */
  gates: MatchGate[]
  source: MatchSource
}

/** Highest score a job can get while a gate fails. */
export const GATE_CAP = 40
/** Share of a soft skill's Jobright score that counts (hard skills count fully). */
export const SOFT_SKILL_WEIGHT = 0.3
/** Weight of a skill the description names only as preferred ("nice to have", "a plus"); required ones weigh 1. */
export const PREFERRED_WEIGHT = 0.5
/** Years of slack on a minimum: "3+ years" is met by 2. Postings round up. */
const YEARS_SLACK = 1

const round = (n: number) => Math.round(n * 100) / 100

/** Words around a skill name that do not change which skill it is: "Python Programming", "React framework". */
const FILLER =
  /\b(?:programming|language|languages|development|developer|framework|frameworks|library|libraries|skills?|experience|proficiency|knowledge|expertise|tools?|platform|basics|fundamentals|concepts|in|of|with|and|using)\b/gi

/**
 * The sides of a slash when they name alternative skills ("React/Vue", "AWS / GCP"), else the name whole.
 * A compound name is one skill: `CI/CD`, `TCP/IP`, `PL/SQL` (`SLASH_NAMES`), and any whose side is one or
 * two letters ("I/O"), so `CD` alone is never evidence of `CI/CD`.
 */
function slashSides(name: string): string[] {
  if (!name.includes('/')) return [name]
  const lower = name.toLowerCase()
  if (SLASH_NAMES.some((n) => lower.includes(n.toLowerCase()))) return [name]
  const sides = name.split(/\s*\/\s*/).map((n) => n.trim())
  return sides.every((n) => n.replace(/[^A-Za-z0-9+#]/g, '').length >= 3) ? sides : [name]
}

/** Every name a requirement could go by: the whole, outside and inside its parentheses, each alternative of a slash. */
function spellings(name: string): string[] {
  const outside = name.replace(/\([^)]*\)/g, ' ')
  const inside = [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1])
  return [...new Set([name, outside, ...inside].flatMap(slashSides).map((n) => n.trim()))].filter((n) => n.length > 0)
}

/** Keys a requirement matches on: each spelling as is, and without filler words. */
function keysOf(name: string): string[] {
  return spellings(name).flatMap((n) => {
    const bare = n.replace(FILLER, ' ').replace(/\s+/g, ' ').trim()
    return bare && bare !== n ? [skillKey(n), skillKey(bare)] : [skillKey(n)]
  })
}

/** Whether the profile has evidence for a requirement: a skill of the same key, or the profile's words name it. */
function hasEvidence(name: string, keys: ReadonlySet<string>, evidence: string): boolean {
  if (keysOf(name).some((k) => keys.has(k))) return true
  return evidence !== '' && spellings(name).some((n) => normalizeSkill(n).length >= 2 && mentionsAffirmatively(evidence, n))
}

/** Requirements from Jobright's `jdCoreSkills`: weight = score (1–3), soft skills × `SOFT_SKILL_WEIGHT`. */
function jobrightRequirements(skills: readonly JobrightSkill[]): MatchSkill[] {
  const byKey = new Map<string, MatchSkill>()
  for (const s of skills) {
    if (typeof s?.skill !== 'string' || !s.skill.trim()) continue
    const soft = s.type === 'soft_skill'
    const score = typeof s.score === 'number' && Number.isFinite(s.score) ? Math.min(3, Math.max(1, s.score)) : 1
    const req = { skill: displaySkill(s.skill), weight: round(score * (soft ? SOFT_SKILL_WEIGHT : 1)), soft }
    const key = skillKey(s.skill)
    const had = byKey.get(key)
    if (!had || had.weight < req.weight) byKey.set(key, req)
  }
  return [...byKey.values()]
}

/** A heading line ("Requirements:", "## Nice to have", "**Bonus**"): short, and set off by `#`, `**` or a colon. */
const HEADING = /^\s*(?:#{1,6}\s+.{1,80}|\*\*[^*]{1,80}\*\*:?|[^.!?]{1,60}:)\s*$/
/** Words that make a section or a sentence a preference, not a requirement. */
const PREFERRED =
  /\b(?:prefer\w*|a plus|pluses|nice[\s-]to[\s-]haves?|bonus(?:es)?|desir\w*|good[\s-]to[\s-]haves?|ideally|not required|optional)\b/i

/** Sentence ends, except after an abbreviation's period: "Ph.D. in Computer Science required" is one sentence. */
const SENTENCE_END = /(?<=[.!?;])(?<!\b(?:Ph\.D|B\.Sc?|M\.Sc?|B\.A|M\.A|B\.E|M\.E|e\.g|i\.e|U\.S|vs)\.)\s+/

/** A heading over must-haves: "Requirements", "Minimum qualifications", "Must have", "What you need". */
const REQUIRED_HEADING = /\b(?:requirements?|required|minimum|basic|must[\s-]haves?|qualifications|what you(?:['’]ll)? need)\b/i

interface Sentence {
  text: string
  /** It or its section says it is a preference. */
  preferred: boolean
  /** Its section's heading names must-haves ("Minimum qualifications:"). */
  required: boolean
  /** Which section it is in (0 before the first heading), to read a bullet against its siblings. */
  section: number
}

/** A description as sentences, each marked with its section's kind. Headings are dropped. */
function sentences(description: string): Sentence[] {
  const out: Sentence[] = []
  let preferredSection = false
  let requiredSection = false
  let section = 0
  for (const line of description.split('\n')) {
    if (!line.trim()) continue
    if (HEADING.test(line)) {
      preferredSection = PREFERRED.test(line)
      requiredSection = !preferredSection && REQUIRED_HEADING.test(line)
      section++
      continue
    }
    for (const text of line.split(SENTENCE_END)) {
      if (text.trim()) out.push({ text, preferred: preferredSection || PREFERRED.test(text), required: requiredSection, section })
    }
  }
  return out
}

/**
 * Requirements read from the description, title and tags: every skill of the profile and of
 * `TECH_VOCABULARY` the job names, weight 1 when named anywhere as required, `PREFERRED_WEIGHT` when only
 * as preferred.
 */
function descriptionRequirements(job: MatchJob, profileSkills: readonly string[]): MatchSkill[] {
  const parts = sentences(job.description.slice(0, 20_000))
  const required = [job.title, ...(job.tags ?? []), ...parts.filter((p) => !p.preferred).map((p) => p.text)].join('\n')
  const preferred = parts
    .filter((p) => p.preferred)
    .map((p) => p.text)
    .join('\n')
  const byKey = new Map<string, MatchSkill>()
  for (const name of [...profileSkills, ...TECH_VOCABULARY]) {
    const key = skillKey(name)
    if (byKey.get(key)?.weight === 1) continue
    const weight = mentions(required, name) ? 1 : mentions(preferred, name) ? PREFERRED_WEIGHT : 0
    if (weight > (byKey.get(key)?.weight ?? 0)) byKey.set(key, { skill: displaySkill(name), weight, soft: false })
  }
  return [...byKey.values()]
}

/** "5+ years of experience", "3-5 years of professional software experience", "minimum of 4 years' experience". */
const YEARS =
  /\b(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?years?['’]?\s+(?:of\s+)?(?:[\w/&+#.-]+\s+){0,5}?experience\b/gi

/** Years a job asks for: the board's number, else the largest "N+ years … experience" in a required sentence. */
export function minimumYears(job: MatchJob): number | null {
  if (typeof job.minYearsExperience === 'number') return job.minYearsExperience
  let most: number | null = null
  for (const { text, preferred } of sentences(job.description)) {
    if (preferred) continue
    for (const m of text.matchAll(YEARS)) {
      const n = Number(m[1])
      if (n > 0 && n <= 20 && (most === null || n > most)) most = n
    }
  }
  return most
}

/** Degree fields grouped by area: a job asking for one area is met by a profile degree in the same area. */
const FIELD_AREAS: { label: string; re: RegExp }[] = [
  {
    label: 'computing, engineering or math',
    re: /\b(?:computer|software|computing|informatics|information\s+(?:technology|systems|science)|data\s+science|electrical|electronics?|telecommunications?|mathematics|math|statistics|physics)\b/i
  },
  {
    label: 'chemistry or a life science',
    re: /\b(?:chemistry|chemical|biochem\w*|biology|biological|life\s+sciences?|biotech\w*|pharmac\w*|microbiology|molecular)\b/i
  },
  { label: 'business or finance', re: /\b(?:business|finance|accounting|economics|marketing|mba)\b/i },
  { label: 'health care', re: /\b(?:nursing|medicine|public\s+health|kinesiology)\b/i },
  { label: 'mechanical, civil or industrial engineering', re: /\b(?:mechanical|civil|aerospace|industrial|manufacturing|materials)\b/i }
]

/** A degree: the words in any case, abbreviations only as written ("BS", "B.S.", "MSc", "Ph.D."), so "be" or "ms" are not. */
const DEGREE = /\b(?:[Bb]achelor['’]?s?|[Mm]aster['’]?s?|[Dd]octorate|[Dd]egree)\b|\b(?:B\.?S\.?c?|B\.A\.|B\.E\.|M\.?S\.?c?|M\.E\.|Ph\.?\s?D)(?![A-Za-z])/
/** A degree that may be replaced by experience is not a must-have. */
const EQUIVALENT = /\bor\s+(?:an?\s+)?(?:\w+\s+){0,2}?(?:equivalent|comparable)\b|\bequivalent\s+(?:\w+\s+){0,3}?experience\b/i
/** How far after the degree word its field is read: "Bachelor's degree in Chemistry, Biology or a related field". */
const FIELD_WINDOW = 160
const PHD = /\b(?:Ph\.?\s?D|[Dd]octorate)(?![A-Za-z])/
/**
 * A PhD the sentence itself requires. Under a must-have heading a bullet naming only a PhD is required too,
 * unless a sibling bullet names another degree: then the PhD is one of the options ("- M.S. in CS", "- Ph.D. in CS").
 */
const PHD_REQUIRED = /^\W*(?:requirements?|required|minimum qualifications?)\b|\brequired\b|\bmust\s+(?:have|hold)\b|\brequires?\b/i

function areasOf(text: string): string[] {
  return FIELD_AREAS.filter((a) => a.re.test(text)).map((a) => a.label)
}

/** The degree gates: a required field in an area none of the profile's degrees is in, or a required PhD. */
function degreeGates(job: MatchJob, degrees: readonly ProfileDegree[]): MatchGate[] {
  if (degrees.length === 0) return []
  const held = new Set(degrees.flatMap((d) => areasOf(`${d.field} ${d.degree}`)))
  const phd = degrees.some((d) => PHD.test(d.degree) || /\bdoctor/i.test(d.degree))
  const gates: MatchGate[] = []
  const all = sentences(job.description)
  const otherLevel = (t: string) => /\b(?:[Bb]achelor|[Mm]aster)|\b(?:B\.?S|M\.?S|B\.A|MD)\b/.test(t)
  for (const { text, preferred, required, section } of all) {
    const at = text.search(DEGREE)
    if (preferred || at < 0 || EQUIVALENT.test(text)) continue
    const asked = areasOf(text.slice(at, at + FIELD_WINDOW))
    if (held.size > 0 && asked.length > 0 && !asked.some((a) => held.has(a)) && !gates.some((g) => g.kind === 'degree')) {
      gates.push({ kind: 'degree', reason: `Asks for a degree in ${asked.join(' / ')}` })
    }
    const mustHave =
      PHD_REQUIRED.test(text) || (required && !all.some((o) => o.section === section && !o.preferred && otherLevel(o.text)))
    if (!phd && !otherLevel(text) && PHD.test(text) && mustHave && !gates.some((g) => g.reason === 'Asks for a PhD')) {
      gates.push({ kind: 'degree', reason: 'Asks for a PhD' })
    }
  }
  return gates
}

/** A clearance the profile says it holds ("Active Secret clearance"). */
const HOLDS_CLEARANCE = /\b(?:secret|top secret|ts\/sci|security|dod|public trust)\s+clearance\b/i
/** A clearance the person must already hold, not just be able to get. */
const ACTIVE_CLEARANCE = /\b(?:active|current|hold|holds|possess|maintain)\b[^.;\n]{0,40}\bclearance\b/i

function gatesOf(job: MatchJob, s: MatchProfile): MatchGate[] {
  const gates = degreeGates(job, s.degrees ?? [])
  const asked = minimumYears(job)
  if (asked !== null && s.years + YEARS_SLACK < asked) {
    gates.push({ kind: 'years', reason: `Asks for ${asked}+ years of experience (you have ${s.years})` })
  }
  if (requiresClearance(job.description) && !(s.evidence && mentionsAffirmatively(s.evidence, 'clearance') && HOLDS_CLEARANCE.test(s.evidence))) {
    if (s.needsSponsorship) gates.push({ kind: 'clearance', reason: 'Asks for a security clearance (citizens only)' })
    else if (ACTIVE_CLEARANCE.test(job.description)) gates.push({ kind: 'clearance', reason: 'Asks for an active security clearance' })
  }
  if (s.needsSponsorship && sponsorshipOf({ description: job.description, visaSponsorship: job.visaSponsorship }) === false) {
    gates.push({ kind: 'sponsorship', reason: 'Says it does not sponsor visas' })
  }
  return gates
}

const heaviest = (a: MatchSkill, b: MatchSkill) => b.weight - a.weight || a.skill.localeCompare(b.skill)

/**
 * The match score of a job against the master profile: `{ score, matched, missing, gates, source }`.
 *
 * Requirements come from `job.jdCoreSkills` when it has any (`source: 'jobright-skills'`), else from the
 * description (`source: 'description'`). Synonyms normalize through `skills.ts` (`JS` = `JavaScript`,
 * `Postgres` = `PostgreSQL`, `k8s` = `Kubernetes`), and "Python Programming" or "Amazon Web Services (AWS)"
 * match the profile's `Python` / `AWS`. Gates are read from the description, so a job without one (an
 * Explore row before its posting loads) has no gates.
 *
 * @example
 * const s = profileSignals(profile)
 * const { score, missing, gates } = matchScore(job, s)
 * // score 72, missing [{ skill: 'Kafka', weight: 1, soft: false }], gates []
 */
export function matchScore(job: MatchJob, s: MatchProfile): MatchResult {
  const jobright = job.jdCoreSkills ? jobrightRequirements(job.jdCoreSkills) : []
  const source: MatchSource = jobright.length > 0 ? 'jobright-skills' : 'description'
  const requirements = source === 'jobright-skills' ? jobright : descriptionRequirements(job, s.skills)
  const keys = new Set(s.skills.flatMap(keysOf))
  const evidence = s.evidence ?? ''
  const matched: MatchSkill[] = []
  const missing: MatchSkill[] = []
  for (const r of requirements) (hasEvidence(r.skill, keys, evidence) ? matched : missing).push(r)
  const total = requirements.reduce((n, r) => n + r.weight, 0)
  const have = matched.reduce((n, r) => n + r.weight, 0)
  const coverage = total > 0 ? Math.round((have / total) * 100) : 0
  const gates = gatesOf(job, s)
  return {
    score: gates.length > 0 ? Math.min(coverage, GATE_CAP) : coverage,
    matched: matched.sort(heaviest),
    missing: missing.sort(heaviest),
    gates,
    source
  }
}
