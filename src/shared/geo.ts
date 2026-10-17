import type { FieldKey } from './apply-types'

/**
 * Places, for application forms (#136): the parts of the profile's one-line
 * location ("Portland, OR" → Portland / Oregon / United States), and which
 * option of a site's list is the profile's value (a state code against its
 * name, "USA" against "United States of America (+1)"). Pure; no DOM.
 */

/** A value a dropdown or suggestion list can be filled with: a profile field, or a phone default. */
export type ChoiceKey = Exclude<FieldKey, 'resume' | 'coverLetter'> | 'phoneType' | 'phoneCountryCode'

/** US states, DC and Puerto Rico: code → name. */
export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  PR: 'Puerto Rico',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming'
}

/** Canadian provinces and territories: code → name. */
export const CA_PROVINCES: Readonly<Record<string, string>> = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon'
}

/** Ways sites name the same country; the first is the canonical name Huntgry fills. */
export const COUNTRY_SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['United States', 'United States of America', 'USA', 'US', 'U.S.', 'U.S.A.', 'America'],
  ['Canada', 'CA'],
  ['United Kingdom', 'UK', 'U.K.', 'Great Britain', 'GB', 'Britain', 'United Kingdom of Great Britain and Northern Ireland'],
  ['India', 'IN', 'Bharat'],
  ['Germany', 'DE', 'Deutschland'],
  ['France', 'FR'],
  ['Australia', 'AU'],
  ['Ireland', 'IE'],
  ['Netherlands', 'NL', 'The Netherlands', 'Holland'],
  ['Spain', 'ES'],
  ['Mexico', 'MX'],
  ['Brazil', 'BR'],
  ['Singapore', 'SG'],
  ['Japan', 'JP'],
  ['China', 'CN'],
  ['Israel', 'IL'],
  ['Poland', 'PL'],
  ['Sweden', 'SE'],
  ['Switzerland', 'CH'],
  ['New Zealand', 'NZ'],
  ['Nepal', 'NP'],
  ['Pakistan', 'PK'],
  ['Philippines', 'PH'],
  ['South Korea', 'Korea', 'Republic of Korea', 'Korea, Republic of', 'KR']
]

/** Phone dial codes of the countries above (by canonical name). */
const DIAL_CODES: Readonly<Record<string, string>> = {
  'United States': '1',
  Canada: '1',
  'United Kingdom': '44',
  India: '91',
  Germany: '49',
  France: '33',
  Australia: '61',
  Ireland: '353',
  Netherlands: '31',
  Spain: '34',
  Mexico: '52',
  Brazil: '55',
  Singapore: '65',
  Japan: '81',
  China: '86',
  Israel: '972',
  Poland: '48',
  Sweden: '46',
  Switzerland: '41',
  'New Zealand': '64',
  Nepal: '977',
  Pakistan: '92',
  Philippines: '63',
  'South Korea': '82'
}

/** Lower case, no accents, punctuation as spaces: "U.S.A." → "u s a", "Québec" → "quebec". */
export function normalizePlace(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Abbreviations compare without their dots: "u s a" → "usa". */
const squash = (normalized: string) => (/^([a-z] )+[a-z]$/.test(normalized) ? normalized.replace(/ /g, '') : normalized)
const key = (value: string) => squash(normalizePlace(value))

const byName = (table: Readonly<Record<string, string>>) => new Map(Object.entries(table).map(([code, name]) => [key(name), code]))
const US_BY_NAME = byName(US_STATES)
const CA_BY_NAME = byName(CA_PROVINCES)

/** A US state or Canadian province from its code or name, or null. */
export function regionOf(value: string): { code: string; name: string; country: 'United States' | 'Canada' } | null {
  const k = key(value)
  if (!k) return null
  const upper = k.toUpperCase()
  if (US_STATES[upper]) return { code: upper, name: US_STATES[upper], country: 'United States' }
  if (CA_PROVINCES[upper]) return { code: upper, name: CA_PROVINCES[upper], country: 'Canada' }
  const us = US_BY_NAME.get(k)
  if (us) return { code: us, name: US_STATES[us], country: 'United States' }
  const ca = CA_BY_NAME.get(k)
  if (ca) return { code: ca, name: CA_PROVINCES[ca], country: 'Canada' }
  return null
}

const COUNTRY_INDEX = new Map<string, readonly string[]>()
for (const group of COUNTRY_SYNONYMS) for (const name of group) COUNTRY_INDEX.set(key(name), group)

/**
 * The canonical name of a country written any known way ("USA" → "United States"), or null.
 * Two-letter codes count only when `codes` is true: in a location, "IN" or "CA" is a state.
 */
export function countryOf(value: string, { codes = true } = {}): string | null {
  const k = key(value)
  const group = COUNTRY_INDEX.get(k)
  if (!group) return null
  if (!codes && /^[a-z]{2}$/.test(k) && k !== 'us' && k !== 'uk') return null
  return group[0]
}

/** Every way to write `country` that Huntgry knows (itself when unknown). */
function countryForms(country: string): string[] {
  const group = COUNTRY_INDEX.get(key(country))
  return (group ?? [country]).map(key)
}

export interface LocationParts {
  city: string
  /** Full state or province name ("Oregon"); '' when the location names none. */
  state: string
  /** Canonical country name; '' when the location does not say. */
  country: string
  postalCode: string
}

const US_ZIP = /^(.*?)\s*\b(\d{5}(?:-\d{4})?)$/
const CA_POSTAL = /^(.*?)\s*\b([A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d)$/
const REMOTE = /^(remote|anywhere|worldwide|n\/?a)$/i

/**
 * The parts of a one-line location: "Portland, OR" → Portland / Oregon /
 * United States; "Toronto, ON, Canada" → Toronto / Ontario / Canada;
 * "Portland, OR 97201" also yields the postal code; "Remote" yields nothing;
 * a bare city is a city only.
 */
export function locationParts(location: string): LocationParts {
  const out: LocationParts = { city: '', state: '', country: '', postalCode: '' }
  const parts = location
    .split(/[,;]|\s+[-–|]\s+/)
    .map((p) => p.trim().replace(/\s*\((remote|hybrid|on-?site)\)$/i, ''))
    .filter(Boolean)
  if (parts.length === 0) return out
  // A trailing country ("…, Canada", "…, USA").
  if (parts.length > 1) {
    const country = countryOf(parts[parts.length - 1], { codes: false })
    if (country) {
      out.country = country
      parts.pop()
    }
  }
  // A postal code after the state ("OR 97201") or on its own.
  const last = parts[parts.length - 1]
  const zip = US_ZIP.exec(last) ?? CA_POSTAL.exec(last)
  if (zip && parts.length > 1) {
    out.postalCode = zip[2].toUpperCase()
    if (zip[1].trim()) parts[parts.length - 1] = zip[1].trim()
    else parts.pop()
  }
  if (parts.length > 1) {
    const region = regionOf(parts[parts.length - 1])
    if (region && (!out.country || out.country === region.country)) {
      out.state = region.name
      out.country ||= region.country
      parts.pop()
    }
  }
  if (parts.length === 1 && !out.country && !out.state) {
    const country = countryOf(parts[0], { codes: false })
    if (country) return { ...out, country }
  }
  const city = parts[0] ?? ''
  if (!REMOTE.test(city)) out.city = city
  return out
}

/** Options that are not an answer: "No items.", "No results found", "Loading…". */
export const NO_RESULT_OPTION = /^(no (items?|results?|matches|options?|location)\b|nothing found|loading|searching)/i

const PHONE_TYPES = ['mobile', 'cell', 'cellular', 'mobile phone', 'cell phone', 'mobile cell', 'cellphone']

/** An option's text without a dial code ("United States of America (+1)" → "united states of america"). */
function withoutDialCode(option: string): { rest: string; dial: string | null } {
  const dial = /\(?\+\s?(\d{1,4})\)?/.exec(option)
  return { rest: key(option.replace(/\(?\+\s?\d{1,4}\)?/g, ' ')), dial: dial ? dial[1] : null }
}

/**
 * Whether `option` (a site's wording) is `value` for `key`: case and
 * punctuation never matter; a state matches its code or name, a country any
 * of its synonyms, a phone country code its country with or without the dial
 * code ("United States of America (+1)", "US +1", or "+1" alone), a phone
 * type any word for a mobile phone.
 */
export function matchesOption(choice: ChoiceKey, value: string, option: string): boolean {
  if (!value.trim() || !option.trim()) return false
  const v = key(value)
  const o = key(option)
  if (v === o) return true
  if (choice === 'state') {
    const want = regionOf(value)
    const have = regionOf(option)
    return want !== null && have !== null && want.code === have.code && want.country === have.country
  }
  if (choice === 'country') {
    const forms = countryForms(value)
    return forms.includes(o) || forms.includes(withoutDialCode(option).rest)
  }
  if (choice === 'phoneCountryCode') {
    const country = countryOf(value) ?? value
    const { rest, dial } = withoutDialCode(option)
    if (rest && countryForms(country).includes(rest)) return true
    // A bare dial code ("+1") names the country only when nothing else is written.
    return !rest && dial !== null && DIAL_CODES[country] === dial
  }
  if (choice === 'phoneType') return PHONE_TYPES.includes(v) ? PHONE_TYPES.includes(o) : false
  return false
}

/**
 * The one option of `options` that is `value` (see `matchesOption`), or null.
 * An option written exactly like the value wins; otherwise the first match.
 * A bare dial code shared by several countries ("+1") is never chosen when
 * the list also names countries.
 */
export function chooseOption(choice: ChoiceKey, value: string, options: readonly string[]): string | null {
  const usable = options.filter((o) => o.trim() && !NO_RESULT_OPTION.test(o.trim()))
  const exact = usable.find((o) => key(o) === key(value))
  if (exact) return exact
  const matches = usable.filter((o) => matchesOption(choice, value, o))
  if (choice === 'phoneCountryCode' && matches.length > 1) {
    // Prefer an option that names the country over a bare code.
    const named = matches.find((o) => withoutDialCode(o).rest)
    if (named) return named
  }
  return matches[0] ?? null
}

/**
 * The best suggestion of a location typeahead (Greenhouse, Lever) for the
 * profile's location: the option written like the location itself; else one
 * that starts with (then contains) the city and, when the profile names a
 * state or country, names it too ("Portland, Oregon, United States" for
 * "Portland, OR", never "Portland, Maine"). Null when nothing fits.
 */
export function chooseLocationOption(location: string, options: readonly string[]): string | null {
  const usable = options.filter((o) => o.trim() && !NO_RESULT_OPTION.test(o.trim()))
  const want = key(location)
  const exact = usable.find((o) => key(o) === want)
  if (exact) return exact
  const parts = locationParts(location)
  const city = key(parts.city || location)
  if (!city) return null
  const words = (o: string) => ` ${normalizePlace(o)} `
  const region = parts.state ? regionOf(parts.state) : null
  const namesRegion = (o: string) =>
    !region || words(o).includes(` ${normalizePlace(region.name)} `) || words(o).includes(` ${region.code.toLowerCase()} `)
  const namesCountry = (o: string) =>
    !parts.country || region !== null || countryForms(parts.country).some((c) => words(o).includes(` ${c} `))
  const fits = usable.filter((o) => words(o).includes(` ${normalizePlace(parts.city || location)} `) && namesRegion(o) && namesCountry(o))
  return fits.find((o) => normalizePlace(o).startsWith(city)) ?? fits[0] ?? null
}

/** The country whose phone code a form wants: the profile's country, else "+1" phones are US numbers. */
export function phoneCountryOf(country: string, phone: string): string {
  if (country.trim()) return countryOf(country) ?? country.trim()
  return /^\s*\+\s?1\b/.test(phone) ? 'United States' : ''
}
