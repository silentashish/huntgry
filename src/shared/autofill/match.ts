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
  'address-line1': 'addressLine1',
  'street-address': 'addressLine1',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country'
}

/** Autocomplete tokens of address parts Huntgry never fills (line 2, …). */
const AUTOCOMPLETE_NEVER = new Set(['address-line2', 'address-line3', 'address-level3', 'address-level4'])

/** Labels or names about someone or something else than the applicant now. */
const NEGATIVE =
  /\b(previous|former|past|prior|reference|referee|emergency|referr\w*|refer|hear|heard|recruiter|manager|school|university|college|salary|parent|spouse|guardian|confirm|verify|repeat|re-?enter|preferred|nick ?name|middle|citizenship|nationality|birth|billing|shipping|mailing|permanent)\b/

/** Words of an identifier: `first_name`, `firstName`, `applicant[first-name]` → `first name`. */
export function identifierWords(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Never a profile value: a second address line, a phone's country code. */
const NEVER = /\b(address ?(line ?)?2|address ?two|apt|apartment|suite|unit|country ?code|phone ?code|dial(ing)? ?code|calling ?code)\b/

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
  // A field asking for the whole place ("City and state", "Current location (city, state)") takes the location line.
  [/\b(location|where are you (based|located)|city (and|or|\/)? ?state|city state|city province)\b/, 'location'],
  [/\b(street|address ?(line ?)?1?|address ?one|addr ?1?)\b/, 'addressLine1'],
  [/\b(city|town)\b/, 'city'],
  [/\b(country|united states)\b/, 'country'],
  [/\b(state|province|region)\b/, 'state'],
  [/\b(zip|zip ?code|postal|postal ?code|post ?code|postcode)\b/, 'postalCode'],
  [/\b(current ?company|current ?employer|company|employer|organi[sz]ation|org)\b/, 'currentCompany']
]

function byRules(words: string): TextKey | null {
  if (!words || NEGATIVE.test(words) || NEVER.test(words)) return null
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
  if ([label, ids, placeholder].some((words) => NEGATIVE.test(words) || NEVER.test(words))) return null
  const auto = autocompleteOf(el)
  if (AUTOCOMPLETE_NEVER.has(auto)) return null
  if (AUTOCOMPLETE[auto]) return { key: AUTOCOMPLETE[auto], score: 3 }
  const idKey = byRules(ids)
  if (idKey) return { key: idKey, score: 2 }
  // A long label is a custom question ("Why do you want to join…"), not a contact field.
  const labelKey = label.length <= 80 ? byRules(label) : null
  if (labelKey) return { key: labelKey, score: 1 }
  return null
}

const autocompleteOf = (el: Element) => (el.getAttribute('autocomplete') ?? '').toLowerCase().trim().split(/\s+/).pop() ?? ''

/** Keys a dropdown (select, combobox, Workday listbox button) is filled with from the profile. */
const CHOICE_KEYS: ReadonlySet<TextKey> = new Set(['country', 'state', 'city'])

/**
 * The profile value a dropdown asks for (#136): only a country, a state or a
 * city, and only when its autocomplete token, its name / id or a short label
 * says exactly that ("Country", "State / Province"). A question ("Are you
 * authorized to work in the United States?") is never one.
 */
export function matchChoiceField(el: FormControl): (Match & { key: TextKey }) | null {
  const control = el
  const label = identifierWords(labelOf(control))
  const ids = identifierWords(`${el.getAttribute('name') ?? ''} ${el.id}`.trim())
  if ([label, ids].some((words) => NEGATIVE.test(words) || NEVER.test(words))) return null
  const auto = autocompleteOf(el)
  if (AUTOCOMPLETE_NEVER.has(auto)) return null
  const fromAuto = AUTOCOMPLETE[auto]
  if (fromAuto) return CHOICE_KEYS.has(fromAuto) ? { key: fromAuto, score: 3 } : null
  const idKey = byRules(ids)
  if (idKey && CHOICE_KEYS.has(idKey)) return { key: idKey, score: 2 }
  // Short labels only, and never a question.
  if (label.length > 30 || /\?/.test(labelOf(control))) return null
  const labelKey = byRules(label)
  return labelKey && CHOICE_KEYS.has(labelKey) ? { key: labelKey, score: 1 } : null
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
