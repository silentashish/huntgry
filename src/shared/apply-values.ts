import type { FillEducation, FillExperience, FillProfile, FillValues, MonthYear } from './apply-types'
import { countryOf, locationParts } from './geo'
import type { MasterProfile } from './master-profile'

/** Form values from the master profile (pure; only the contact block and the current employer are used). */

/** Lower-case name particles that belong to the last name ("Ludwig van Beethoven" → "van Beethoven"). */
const PARTICLES = new Set([
  'van',
  'von',
  'de',
  'del',
  'della',
  'der',
  'den',
  'di',
  'da',
  'du',
  'la',
  'le',
  'ter',
  'bin',
  'al',
  'st',
  'st.'
])

/**
 * Splits a full name for forms that ask for first and last name separately:
 * the last word is the last name, together with any particles right before it;
 * a single word is a first name only.
 */
export function splitName(name: string): { first: string; last: string } {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { first: '', last: '' }
  if (words.length === 1) return { first: words[0], last: '' }
  let start = words.length - 1
  while (start > 1 && PARTICLES.has(words[start - 1].toLowerCase())) start--
  return { first: words.slice(0, start).join(' '), last: words.slice(start).join(' ') }
}

const CURRENT = /\b(present|current|now|today|ongoing)\b/i

/** The employer of the first experience entry that has not ended, else ''. */
export function currentCompany(profile: MasterProfile): string {
  const entry = profile.experience.find((e) => !e.end.trim() || CURRENT.test(e.end))
  return entry?.company.trim() ?? ''
}

/**
 * A profile link as a full URL (URL fields reject `linkedin.com/in/ada`): a bare
 * host/path gets `https://`, a bare handle is put on `handleBase`.
 */
export function asUrl(value: string, handleBase?: string): string {
  const v = value.trim()
  if (!v || /^https?:\/\//i.test(v)) return v
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)) return `https://${v}`
  if (handleBase && /^@?[\w-]+$/.test(v)) return `${handleBase}${v.replace(/^@/, '')}`
  return v
}

/**
 * The address parts forms ask for (#136), from the contact block: city and
 * state come from `location` ("Portland, OR" → Portland / Oregon); the
 * country is the contact's own, else the one the location names or implies
 * (a US state → United States); the postal code is the contact's, else one
 * written in the location ("Portland, OR 97201").
 */
export function addressValues(contact: { location: string; postalCode: string; country: string }): {
  city: string
  state: string
  postalCode: string
  country: string
} {
  const parts = locationParts(contact.location)
  const own = contact.country.trim()
  return {
    city: parts.city,
    state: parts.state,
    postalCode: contact.postalCode.trim() || parts.postalCode,
    country: own ? (countryOf(own) ?? own) : parts.country
  }
}

export function fillValuesFrom(profile: MasterProfile): FillValues {
  const c = profile.contact
  const fullName = c.name.trim().replace(/\s+/g, ' ')
  const { first, last } = splitName(fullName)
  const address = addressValues(c)
  return {
    firstName: first,
    lastName: last,
    fullName,
    email: c.email.trim(),
    phone: c.phone.trim(),
    location: c.location.trim(),
    addressLine1: c.address.trim(),
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    linkedin: asUrl(c.linkedin, 'https://www.linkedin.com/in/'),
    github: asUrl(c.github, 'https://github.com/'),
    website: asUrl(c.website),
    currentCompany: currentCompany(profile)
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A profile date as month and year (#136): "Jan 2022", "January 2022", "2022-01", "01/2022", "1/2022"; a bare
 * year ("2022") is January of that year. "Present" and anything unreadable give null.
 */
export function parseMonthYear(text: string): MonthYear | null {
  const t = text.trim().toLowerCase()
  if (!t || CURRENT.test(t)) return null
  const ok = (month: number, year: number): MonthYear | null =>
    month >= 1 && month <= 12 && year >= 1900 && year <= 2100 ? { month, year } : null
  let m = /^([a-z]{3,9})\.?,?\s+(\d{4})$/.exec(t)
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3)) + 1
    return month ? ok(month, Number(m[2])) : null
  }
  m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(t)
  if (m) return ok(Number(m[2]), Number(m[1]))
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(t)
  if (m) return ok(Number(m[1]), Number(m[2]))
  m = /^(\d{4})$/.exec(t)
  if (m) return ok(1, Number(m[1]))
  return null
}

const MAX_DESCRIPTION = 2000
const MAX_SKILLS = 40

/** Markdown emphasis dropped from a highlight ("cutting latency by **40%**" → "cutting latency by 40%"). */
const plain = (text: string) => text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()

/**
 * The profile's repeatable sections as the page fills them (#136, Workday My Experience): work experience (the
 * highlights joined by newlines as the role description, at most 2000 characters), education, skills (every group
 * flattened, deduplicated case-insensitively, at most 40) and websites (GitHub, then the website).
 */
export function fillProfileFrom(profile: MasterProfile): FillProfile {
  const experience = profile.experience
    .filter((e) => e.company.trim() || e.role.trim())
    .map((e): FillExperience => {
      const current = !e.end.trim() || CURRENT.test(e.end)
      return {
        company: e.company.trim(),
        role: e.role.trim(),
        location: e.location.trim(),
        start: parseMonthYear(e.start),
        end: current ? null : parseMonthYear(e.end),
        current,
        description: e.highlights.map(plain).filter(Boolean).join('\n').slice(0, MAX_DESCRIPTION)
      }
    })
  const education = profile.education
    .filter((e) => e.institution.trim())
    .map(
      (e): FillEducation => ({
        school: e.institution.trim(),
        degree: e.degree.trim(),
        field: e.field.trim(),
        gpa: e.gpa.trim(),
        start: parseMonthYear(e.start),
        end: parseMonthYear(e.end)
      })
    )
  const seen = new Set<string>()
  const skills: string[] = []
  for (const group of profile.skills) {
    for (const item of group.items) {
      const skill = item.trim()
      const key = skill.toLowerCase()
      if (!skill || seen.has(key) || skills.length >= MAX_SKILLS) continue
      seen.add(key)
      skills.push(skill.slice(0, 80))
    }
  }
  const websites = [asUrl(profile.contact.github, 'https://github.com/'), asUrl(profile.contact.website)].filter(Boolean)
  return { experience, education, skills, websites }
}
