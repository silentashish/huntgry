import type { FillValues } from './apply-types'
import type { MasterProfile } from './master-profile'

/** Form values from the master profile (pure; only the contact block and the current employer are used). */

/** Lower-case name particles that belong to the last name ("Ludwig van Beethoven" → "van Beethoven"). */
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'der', 'den', 'di', 'da', 'du', 'la', 'le', 'ter', 'bin', 'al', 'st', 'st.'])

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

export function fillValuesFrom(profile: MasterProfile): FillValues {
  const c = profile.contact
  const fullName = c.name.trim().replace(/\s+/g, ' ')
  const { first, last } = splitName(fullName)
  return {
    firstName: first,
    lastName: last,
    fullName,
    email: c.email.trim(),
    phone: c.phone.trim(),
    location: c.location.trim(),
    linkedin: asUrl(c.linkedin, 'https://www.linkedin.com/in/'),
    github: asUrl(c.github, 'https://github.com/'),
    website: asUrl(c.website),
    currentCompany: currentCompany(profile)
  }
}
