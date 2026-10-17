/**
 * Application answers (#71): the personal facts screening questions ask for
 * (work authorization, sponsorship, notice period, EEO…), a deterministic
 * matcher from question text to fact, and the rules that turn a remembered
 * answer into one of a page's options. Pure: it runs in the browser tab's
 * preload (the autofill engine), in main and in the renderer.
 *
 * Privacy: the values of `sensitive` facts are stored only under userData
 * (main's answers store), are never sent to a model and never appear in the
 * knowledge graph. A model only ever sees question text, options and the
 * fact *names* below.
 */

export const FACT_KEYS = [
  'workAuthorized',
  'needsSponsorship',
  'over18',
  'willingToRelocate',
  'noticePeriod',
  'earliestStart',
  'salaryExpectation',
  'currentCity',
  'visaStatus',
  'previouslyEmployed',
  'howHeard',
  'securityClearance',
  'yearsExperience',
  'highestEducation',
  'relativeEmployed',
  'pronouns',
  'gender',
  'raceEthnicity',
  'hispanicLatino',
  'veteranStatus',
  'disabilityStatus'
] as const

export type FactKey = (typeof FACT_KEYS)[number]

export interface FactInfo {
  label: string
  /** Demographic / EEO: stored under userData only, masked in lists, never sent to a model or shown in the graph. */
  sensitive: boolean
  /** `yesno` facts are stored as `yes` / `no` / `decline`; `choice` as `decline` or the option text; `text` as typed. */
  kind: 'yesno' | 'choice' | 'text'
}

export const FACTS: Record<FactKey, FactInfo> = {
  workAuthorized: { label: 'Authorized to work', sensitive: false, kind: 'yesno' },
  needsSponsorship: { label: 'Needs visa sponsorship', sensitive: false, kind: 'yesno' },
  over18: { label: '18 or older', sensitive: false, kind: 'yesno' },
  willingToRelocate: { label: 'Willing to relocate', sensitive: false, kind: 'yesno' },
  noticePeriod: { label: 'Notice period', sensitive: false, kind: 'text' },
  earliestStart: { label: 'Earliest start date', sensitive: false, kind: 'text' },
  salaryExpectation: { label: 'Salary expectation', sensitive: false, kind: 'text' },
  currentCity: { label: 'Current city', sensitive: false, kind: 'text' },
  visaStatus: { label: 'Work authorization status / visa type', sensitive: false, kind: 'text' },
  previouslyEmployed: { label: 'Previously worked for this employer', sensitive: false, kind: 'yesno' },
  howHeard: { label: 'How did you hear about us', sensitive: false, kind: 'text' },
  securityClearance: { label: 'Security clearance', sensitive: false, kind: 'yesno' },
  yearsExperience: { label: 'Years of experience', sensitive: false, kind: 'text' },
  highestEducation: { label: 'Highest education', sensitive: false, kind: 'text' },
  relativeEmployed: { label: 'Related to an employee', sensitive: false, kind: 'yesno' },
  pronouns: { label: 'Pronouns', sensitive: true, kind: 'choice' },
  gender: { label: 'Gender', sensitive: true, kind: 'choice' },
  raceEthnicity: { label: 'Race / ethnicity', sensitive: true, kind: 'choice' },
  hispanicLatino: { label: 'Hispanic or Latino', sensitive: true, kind: 'yesno' },
  veteranStatus: { label: 'Protected veteran', sensitive: true, kind: 'yesno' },
  disabilityStatus: { label: 'Disability', sensitive: true, kind: 'yesno' }
}

export const isFactKey = (v: unknown): v is FactKey => typeof v === 'string' && (FACT_KEYS as readonly string[]).includes(v)

/** Lower case, accents and apostrophes dropped, anything else that is not a letter or digit becomes one space. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** FNV-1a, 32 bits, as 8 hex digits (no crypto in the page's preload). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Longest option text reported to main and the panel. */
export const MAX_OPTION_CHARS = 120

/**
 * How an option is named outside the page: its text, or for a longer one a
 * prefix plus a hash of the whole text, so two long options with the same
 * start stay apart and the page can find the exact option again.
 */
export function boundedOption(text: string): string {
  if (text.length <= MAX_OPTION_CHARS) return text
  return `${text.slice(0, MAX_OPTION_CHARS - 12)}… #${fnv1a(text)}`
}

/** Kinds that are answered the same way: typed text, or one choice out of a list. */
function kindGroup(kind: string): string {
  if (kind === 'text' || kind === 'textarea') return 'text'
  if (kind === 'select' || kind === 'radio' || kind === 'combobox') return 'choice'
  return kind
}

/**
 * The memory key of a question: its normalised text, whether it is typed or
 * chosen, and a hash of its sorted options. Element ids are useless here
 * (Workday and Ashby use per-posting UUIDs), so the same question on another
 * posting gets the same key.
 */
export function questionKey(label: string, kind: string, options: readonly string[] = []): string {
  const opts = options.map(normalizeText).filter(Boolean).sort().join('\n')
  return `${kindGroup(kind)}|${normalizeText(label).slice(0, 200)}|${fnv1a(opts)}`
}

/** Consent, certification and acknowledgement: never answered from memory, whatever they mention. */
const NEVER =
  /\b(i (certify|agree|acknowledge|consent|understand|confirm|attest|accept)|consent|acknowledg\w*|privacy|terms|arbitration|certif\w*|signature|sign)\b/

/**
 * Ordered: the first that matches wins (sponsorship before visa status before authorization, a relative's
 * employment before the user's own, Hispanic before race).
 */
const RULES: Array<[FactKey, (q: string) => boolean]> = [
  [
    'needsSponsorship',
    (q) =>
      /\bsponsor/.test(q) &&
      !/\bwithout (the )?(need (for|of) |needing |requiring |any )?(visa |employer |employment )?sponsor/.test(q)
  ],
  // A status or type, not a yes/no: "What is your work authorization status?" (US citizen / H-1B…), "Visa type".
  // Before workAuthorized, which keeps "Are you authorized to work…"; after sponsorship.
  [
    'visaStatus',
    (q) =>
      /\b(visa|immigration|citizenship|authori[sz]ation)( \w+){0,2} (status|type|category)\b/.test(q) ||
      /\b(status|type|category) of (your )?(current )?(us |u s )?(visa|immigration|citizenship|work authori[sz]ation)\b/.test(q) ||
      /\b(which|what) (type of )?visa (do|are|will)\b/.test(q)
  ],
  [
    'workAuthorized',
    (q) =>
      /\b(authori[sz]ed|eligible|legally (able|permitted|allowed|entitled)|permitted|right|entitled) to work\b/.test(q) ||
      /\bwork (authori[sz]ation|permit|eligibility)\b/.test(q)
  ],
  // Affirmative wording only: "Are you under 18?" would invert the answer, so it is left to the user.
  [
    'over18',
    (q) =>
      !/\b(under|younger|less than|below|minor|not yet)\b/.test(q) &&
      /\b(18|eighteen) (years|yrs)( of age)? or (older|over|above)\b|\b(over|at least|older than) (the age of )?(18|eighteen)\b|\b18 or (older|over)\b|\blegal (working )?age\b/.test(q)
  ],
  ['willingToRelocate', (q) => /\brelocat/.test(q)],
  ['noticePeriod', (q) => /\bnotice period\b|\bhow much notice\b|\bweeks? (of )?notice\b/.test(q)],
  ['earliestStart', (q) => /\b(earliest|available|availability|when (can|could) you) (to |date to )?start\b|\bstart date\b/.test(q)],
  [
    'salaryExpectation',
    (q) =>
      /\b(salary|compensation|pay|wage) (expectation|requirement|range|expected|desired)/.test(q) ||
      /\b(expected|desired|target) (annual |base )?(salary|compensation|pay)\b/.test(q)
  ],
  // A relative before the user's own employment: "Have any of your relatives ever been employed by us?".
  [
    'relativeEmployed',
    (q) =>
      /\brelated to (any|an|a) (current |existing )?(employee|staff|member of (our )?staff)/.test(q) ||
      /\brelatives? (\w+ ){0,3}(working|employed|work)\b/.test(q) ||
      /\bfamily members? (\w+ ){0,3}(working|employed|work)\b/.test(q)
  ],
  [
    'previouslyEmployed',
    (q) =>
      // "for / at / by" a named employer ("Have you ever worked for a startup?" or "…with React?" is not this).
      /\b(previously|formerly|ever) (been )?(worked|employed) (for|at|by) (?!(a|an|any|other)\b)/.test(q) ||
      /\b(previously|formerly|ever) (been )?(worked|employed) with (us|our|this company|the company)\b/.test(q) ||
      /\b(former|previous|past) (employee|employment|contractor)\b/.test(q) ||
      /\bworked (here|for us|at \w+|for \w+|with \w+) (before|previously)\b/.test(q)
  ],
  [
    'howHeard',
    (q) =>
      /\bhow (did|do) you (first )?(hear|learn|find out|come to know|discover)\b/.test(q) ||
      /\breferral source\b|\bsource of referral\b/.test(q) ||
      // A bare "Source" label only; longer text with "source" in it is something else ("open source").
      /^(referral |candidate |application )?source$/.test(q)
  ],
  ['securityClearance', (q) => /\bsecurity clearance\b|\bactive (\w+ )?clearance\b/.test(q)],
  // Overall experience only. "Years of Python experience" or "…experience with Java" names a subject: it stays its
  // own question (answered from the profile and remembered by its own key), so one value never fills every skill.
  [
    'yearsExperience',
    (q) =>
      !EXPERIENCE_SUBJECT.test(q) &&
      (YEARS_OF_OVERALL_EXPERIENCE.test(q) ||
        /\bhow many years have you (been )?work(ed|ing)\b/.test(q))
  ],
  [
    'highestEducation',
    (q) =>
      /\bhighest (level of )?(education|degree|qualification)/.test(q) ||
      /\beducation(al)? level\b|\blevel of education\b/.test(q)
  ],
  ['pronouns', (q) => /\bpronoun/.test(q)],
  ['hispanicLatino', (q) => /\bhispanic\b|\blatin[oax]\b/.test(q)],
  ['raceEthnicity', (q) => /\brace\b|\bethnicit/.test(q)],
  ['veteranStatus', (q) => /\bveteran\b|\bmilitary (service|status)\b|\barmed forces\b/.test(q)],
  ['disabilityStatus', (q) => /\bdisabilit/.test(q)],
  ['gender', (q) => /\b(gender|sex)\b/.test(q)],
  ['currentCity', (q) => /\b(current|which|what) city\b/.test(q)]
]

/** "Years of experience", optionally qualified only by words that keep it about overall experience. */
const YEARS_OF_OVERALL_EXPERIENCE =
  /\b(years|yrs) of ((professional|work|working|total|relevant|overall|industry|full time|paid) ){0,2}experience\b/

/**
 * Experience or work about a named subject: "experience with / in / using / of Python", "worked with Java". The
 * industry, the field or the workforce in general is still overall experience.
 */
const EXPERIENCE_SUBJECT =
  /\b(experience|worked|working)\b (\w+ ){0,4}?(with|in|using|of|on)\b(?! (the |this |a |an |your )?(industry|field|workforce|total|general|overall)\b)/

/**
 * Consent, certification, acknowledgement, arbitration, signature: never
 * answered, written or picked from memory, whatever was remembered for it.
 */
export function isConsentQuestion(question: string): boolean {
  const q = normalizeText(question)
  return NEVER.test(q) || CONSENT.test(q)
}

/**
 * Consent in any phrasing, questions included ("Do you agree to receive
 * recruiting emails?", "Do you accept the terms?"): agreeing, accepting,
 * consenting, certifying, attesting, opting in, subscribing, or receiving
 * marketing / recruiting messages.
 */
const CONSENT =
  /\b(agree\w*|accept\w*|consent\w*|acknowledg\w*|certif\w*|attest\w*|opt (in|out)|optin|subscrib\w*|unsubscrib\w*|authori[sz]e (us|the company|\w+ to)|receive (\w+ )?(emails?|messages?|texts?|sms|calls?|communications?|newsletters?|updates|marketing|offers))\b/

/** The fact a question asks for, from its text alone, or null. Deterministic; consent-like text never matches. */
export function matchFact(question: string): FactKey | null {
  const q = normalizeText(question)
  if (!q || q.length > 400 || NEVER.test(q)) return null
  for (const [key, test] of RULES) if (test(q)) return key
  return null
}

const DECLINE =
  /\b(decline|prefer not|rather not|dont wish|do not wish|not wish|choose not|wish not|(dont|do not|not) want to (answer|say|disclose|share|self identify|identify|respond)|not to (answer|say|disclose|self identify|identify)|not specified|no answer)\b/

export const isDecline = (text: string): boolean => DECLINE.test(normalizeText(text))

/** `yes` / `no` for an option or an answer that says so ("No, I do not have a disability"), else null. */
export function yesNoOf(text: string): 'yes' | 'no' | null {
  const t = normalizeText(text)
  if (!t || DECLINE.test(t)) return null
  if (/^(yes|y|true)\b/.test(t)) return 'yes'
  if (/^(no|n|false)\b/.test(t)) return 'no'
  if (/\b(not|dont|do not|am not|have not|havent|no)\b/.test(t)) return 'no'
  if (/\b(i am|i have|i identify|i do)\b/.test(t)) return 'yes'
  return null
}

/** Words that mean the same answer on different forms. */
const SYNONYMS: string[][] = [
  ['male', 'man', 'cis male', 'cisgender male', 'cisgender man'],
  ['female', 'woman', 'cis female', 'cisgender female', 'cisgender woman'],
  ['non binary', 'nonbinary', 'genderqueer', 'gender non conforming'],
  ['he him', 'he him his'],
  ['she her', 'she her hers'],
  ['they them', 'they them theirs'],
  ['white', 'white not hispanic or latino', 'caucasian'],
  ['asian', 'asian not hispanic or latino'],
  ['black or african american', 'black', 'african american', 'black or african american not hispanic or latino'],
  ['two or more races', 'two or more races not hispanic or latino', 'multiracial']
]

/** The one option that satisfies `test`, or null when none or several do. */
function only(options: readonly string[], test: (option: string) => boolean): string | null {
  const hits = options.filter(test)
  return hits.length === 1 ? hits[0] : null
}

/**
 * What to put in a field for a remembered answer, or null when nothing fits
 * (then nothing is written and the question stays with the user):
 * - a typed field gets the text (a yes/no fact as "Yes" / "No"; never "decline");
 * - a list gets one of its own `options`: the same text, else the "decline"
 *   option for a decline, else the single Yes / No option, else a synonym;
 * - a picker whose options the page does not show (react-select) gets the
 *   text to suggest.
 */
export function resolveAnswer(fact: FactKey | null, value: string, kind: string, options: readonly string[]): string | null {
  const answer = value.trim()
  if (!answer) return null
  const info = fact ? FACTS[fact] : null
  const yn = info?.kind === 'yesno' || answer === 'yes' || answer === 'no' ? yesNoOf(answer) : null
  const decline = answer === 'decline' || isDecline(answer)
  if (kind === 'text' || kind === 'textarea') {
    if (decline && info && info.kind !== 'text') return null
    if (yn && info?.kind === 'yesno') return yn === 'yes' ? 'Yes' : 'No'
    return answer
  }
  if (options.length === 0) {
    if (decline) return 'Decline to self-identify'
    if (yn) return yn === 'yes' ? 'Yes' : 'No'
    return answer
  }
  const n = normalizeText(answer)
  const exact = options.find((o) => normalizeText(o) === n)
  if (exact) return exact
  if (decline) return options.find((o) => isDecline(o)) ?? null
  if (yn) return only(options, (o) => yesNoOf(o) === yn)
  const group = SYNONYMS.find((g) => g.includes(n))
  if (group) return only(options, (o) => group.includes(normalizeText(o)))
  return null
}

/** How an answer is stored for a fact: `yes` / `no` / `decline` for yes/no facts, `decline` or the text otherwise. */
export function canonicalAnswer(fact: FactKey, value: string): string {
  const v = value.trim().slice(0, 500)
  if (FACTS[fact].kind === 'text') return v
  if (isDecline(v)) return 'decline'
  if (FACTS[fact].kind === 'yesno') return yesNoOf(v) ?? v
  return v
}

/** A stored answer for display: "Yes", "Decline to self-identify", or the text. */
export function displayAnswer(value: string): string {
  if (value === 'yes') return 'Yes'
  if (value === 'no') return 'No'
  if (value === 'decline') return 'Decline to self-identify'
  return value
}

/**
 * Visa wordings the profile's Work authorization line may use, most specific first: the first match names the
 * status (`visaStatus`). Each is a currently valid US work status that needs, or will need, sponsorship.
 */
const VISAS: Array<[RegExp, string]> = [
  [/\bh ?1 ?b\b/, 'H-1B'],
  [/\bstem opt\b|\bopt stem\b/, 'F-1 STEM OPT'],
  [/\bopt\b/, 'F-1 OPT'],
  // TN also abbreviates Tennessee ("US citizen, Nashville, TN"): only "TN" alone or as a visa.
  [/^tn$|\btn (visa|status|holder|nafta|usmca)\b|\b(nafta|usmca) tn\b/, 'TN'],
  [/\bl ?1 ?[ab]?\b/, 'L-1'],
  [/\be ?3\b/, 'E-3'],
  [/\bo ?1 ?[ab]?\b/, 'O-1'],
  [/\bead\b/, 'EAD']
]

/**
 * Facts the master profile already states, with no new data (#71, #136):
 * - "US citizen" → authorized, no sponsorship, status "US citizen";
 * - "green card" / "permanent resident" → authorized, no sponsorship, status "Permanent resident";
 * - a current visa ("H-1B", "F-1 OPT", "STEM OPT", "TN", "L-1", "E-3", "O-1", "EAD") → authorized, needs
 *   sponsorship, and the visa as the status.
 * Negated, pending or expired wording, a bare "visa" or "sponsorship", and foreign statuses seed nothing.
 * The line is not sensitive (it is in the profile already); the seeds are never written to the answers store.
 */
export function factsFromProfile(workAuthorization: string): Partial<Record<FactKey, string>> {
  const t = normalizeText(workAuthorization)
  if (!t) return {}
  // Negations and anything pending: no seed ("Not a US citizen", "green card pending", "H-1B expired").
  if (/\b(not|non|no|never|no longer|without|former|expired|applying|applied|pending|awaiting|process|processing|progress)\b/.test(t)) return {}
  const visa = VISAS.find(([re]) => re.test(t))
  if (visa) return { visaStatus: visa[1], workAuthorized: 'yes', needsSponsorship: 'yes' }
  // Other visa wording (CPT, "on a visa", "needs sponsorship"): too vague to seed.
  if (/\b(visa|cpt|f ?1|sponsor\w*)\b/.test(t)) return {}
  // Only US status counts (the forms Huntgry sees ask about the US); "Indian citizen" or a Canadian PR says nothing here.
  const us = /\b(us|u s|usa|u s a|united states|american)\b/.test(t)
  const foreign = /\b(canad\w*|uk|british|indian|india|eu|european|australian|mexican|chinese|german|french)\b/.test(t)
  if (foreign) return {}
  if (/\bgreen card\b|\blawful permanent resident\b|\blpr\b/.test(t) || (us && /\bpermanent resident\b/.test(t))) {
    return { visaStatus: 'Permanent resident', workAuthorized: 'yes', needsSponsorship: 'no' }
  }
  if (us && /\b(citizen|citizenship|national)\b/.test(t)) {
    return { visaStatus: 'US citizen', workAuthorized: 'yes', needsSponsorship: 'no' }
  }
  return {}
}

/** What the page's autofill gets with each fill: confirmed facts and the question memory. */
export interface PageAnswers {
  facts: Partial<Record<FactKey, string>>
  /** By `questionKey`. */
  questions: Record<string, QuestionAnswer>
  /**
   * Settings "Use AI to answer unknown questions" (#136), sent by main with each fill: a model's answers (and its
   * mappings to a stored, non-sensitive fact) are written into the page as "AI answers; check them". Off or absent:
   * they are only suggested.
   */
  aiAnswers?: boolean
}

export interface QuestionAnswer {
  /** The fact the question asks for (null: none; the answer is `value`). */
  fact?: FactKey | null
  /**
   * A direct answer to this question, e.g. one given in the panel; on an unconfirmed entry, a model's probable
   * answer from the profile (#136).
   */
  value?: string
  /** The exact option the user confirmed for this question (and these options); wins over the fact's value. */
  option?: string
  /** The user confirmed the mapping (or gave the answer). A model's mapping alone only suggests. */
  confirmed: boolean
  /**
   * The AI answer Huntgry wrote into this question (#136) that this confirmed answer corrects: the page replaces it
   * while the control still shows exactly that and the person has not edited it.
   */
  replace?: string
}

export const NO_ANSWERS: PageAnswers = { facts: {}, questions: {} }
