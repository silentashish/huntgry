import type { FieldKey } from '../apply-types'
import { kindOf, labelOf, type FormControl } from './dom'

/**
 * The generic matcher: which profile value a text field or file input asks
 * for, from (in order of trust) its `autocomplete` token, its `name` / `id`,
 * then its label. Deterministic; anything that mentions a previous employer,
 * a reference, an emergency contact… is never matched. Scores let the engine
 * leave a key unfilled when two fields claim it equally.
 */

export interface Match {
  key: FieldKey
  /** 3 = autocomplete, 2 = name/id, 1 = label. */
  score: number
}

type TextKey = Exclude<FieldKey, 'resume' | 'coverLetter'>

const AUTOCOMPLETE: Record<string, TextKey> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  organization: 'currentCompany',
  'address-level2': 'location'
}

/** Labels or names about someone or something else than the applicant now. */
const NEGATIVE =
  /\b(previous|former|past|prior|reference|referee|emergency|referr\w*|refer|hear|heard|recruiter|manager|school|university|college|salary|parent|spouse|guardian|confirm|verify|repeat|re-?enter|preferred|nick ?name|middle)\b/

/** Words of an identifier: `first_name`, `firstName`, `applicant[first-name]` → `first name`. */
export function identifierWords(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Ordered: the first rule that matches wins, so "first name" is tested before "name". */
const NAME_RULES: Array<[RegExp, TextKey]> = [
  [/\b(first ?name|fname|given ?name|forename)\b/, 'firstName'],
  [/\b(last ?name|lname|surname|family ?name)\b/, 'lastName'],
  [/^(name|full ?name|your ?name|legal ?name|full legal name|candidate ?name|applicant ?name)$/, 'fullName'],
  [/\b(e ?mail|email ?address)\b/, 'email'],
  [/\b(phone|telephone|tel|mobile|cell)\b/, 'phone'],
  [/\blinked ?in\b/, 'linkedin'],
  [/\bgit ?hub\b/, 'github'],
  [/\b(website|web ?site|portfolio|homepage|personal ?site|personal url|blog)\b/, 'website'],
  [/\b(location|city|where are you (based|located))\b/, 'location'],
  [/\b(current ?company|current ?employer|company|employer|organi[sz]ation|org)\b/, 'currentCompany']
]

function byRules(words: string): TextKey | null {
  if (!words || NEGATIVE.test(words)) return null
  for (const [re, key] of NAME_RULES) if (re.test(words)) return key
  return null
}

/**
 * Best guess for a text field, or `null`. A negative word in *any* of the
 * label, `name`, `id` or placeholder rules the field out before anything else
 * is considered: `<label>Company <input name=previous_employer>` or a
 * `reference_email` labelled "Email" is never the applicant's own.
 */
export function matchTextField(el: FormControl): Match | null {
  const label = identifierWords(labelOf(el))
  const ids = identifierWords(`${el.getAttribute('name') ?? ''} ${el.id}`.trim())
  const placeholder = identifierWords(el.getAttribute('placeholder') ?? '')
  if ([label, ids, placeholder].some((words) => NEGATIVE.test(words))) return null
  const auto = (el.getAttribute('autocomplete') ?? '').toLowerCase().trim().split(/\s+/).pop() ?? ''
  if (AUTOCOMPLETE[auto]) return { key: AUTOCOMPLETE[auto], score: 3 }
  const idKey = byRules(ids)
  if (idKey) return { key: idKey, score: 2 }
  // A long label is a custom question ("Why do you want to join…"), not a contact field.
  const labelKey = label.length <= 80 ? byRules(label) : null
  if (labelKey) return { key: labelKey, score: 1 }
  return null
}

/**
 * `resume` or `coverLetter` for a file input, only when its label, name, id or
 * group heading says so. An unnamed or other upload ("Portfolio", "Work
 * sample", `name=attachment` with `accept=.pdf`) is left to the user: the
 * tailored resume must never land in a field that did not ask for it.
 */
export function matchFileField(el: FormControl): Match | null {
  if (kindOf(el) !== 'file') return null
  const words = identifierWords(`${labelOf(el)} ${el.getAttribute('name') ?? ''} ${el.id}`)
  if (/\bcover\b/.test(words)) return { key: 'coverLetter', score: 2 }
  if (/\b(resume|cv|curriculum)\b|résumé/.test(words)) return { key: 'resume', score: 2 }
  return null
}
