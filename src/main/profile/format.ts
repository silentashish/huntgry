import {
  emptyCertification,
  emptyEducation,
  emptyExperience,
  emptyProfile,
  emptyProject,
  emptyPublication,
  type CertificationEntry,
  type ContactInfo,
  type EducationEntry,
  type ExperienceEntry,
  type MasterProfile,
  type ProjectEntry,
  type PublicationEntry
} from '@shared/master-profile'
import { extractDates, linkValue, normalizeKey, singleLine, splitList, tidy } from './text'

/**
 * `master-profile.md` <-> `MasterProfile`.
 *
 * The Markdown file is the single source of truth: the user can edit it by hand,
 * Claude reads it as is, and the app parses it on every read. The format is
 * plain Markdown with one convention: every entry is a `###` heading followed by
 * `- Field: value` bullets, and list fields (Highlights) nest their items.
 * Unknown `##` sections and unknown fields inside an entry are kept, so a save
 * from the app does not drop hand-written content.
 */

export const PROFILE_FORMAT_VERSION = 1

const HEADER = `<!--
  Huntgry master profile (format v${PROFILE_FORMAT_VERSION}). Structure adapted from
  silentashish/claude-resume-generator-skill@712bee3/assets/master_profile.example.md (skill v3).

  This file is the single source of truth for every tailored resume: each
  resume is a *selection* from it, never an addition to it. Keep it exhaustive.
  Edit it in Huntgry or by hand. Huntgry rewrites this comment when it saves.

  Format, so both Huntgry and Claude can read it:
  - One "## Section" per part of the resume. Extra sections you add are kept.
  - Every entry is a "### Heading" followed by "- Field: value" lines.
    Leave out fields you do not need.
  - List fields ("- Highlights:") nest their items one level deeper.
  - Put the measurable result of a highlight in **double asterisks**; the
    resume-tailor renderer turns it into bold text.

  Experience fields:     Role, Start, End, Location, Type, Project, Project link, Technologies, Highlights
  Project fields:        Link, Dates, Technologies, Description, Highlights
  Education fields:      Degree, Field, Start, End, Location, GPA, Highlights
  Certification fields:  Issuer, Date, Link
  Publication fields:    Venue, Date, Link, Description

  Example entry:

  ### Company Name
  - Role: Software Engineer
  - Start: Jan 2022
  - End: Present
  - Location: City, ST
  - Highlights:
    - Rebuilt the billing API, cutting p95 latency by **40%**.
-->`

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function serializeMasterProfile(p: MasterProfile): string {
  const out: string[] = [HEADER, '', '# Master Profile', '']

  section(out, 'Contact', [
    field('Name', p.contact.name),
    field('Headline', p.contact.headline),
    field('Location', p.contact.location),
    field('Email', p.contact.email),
    field('Phone', p.contact.phone),
    field('LinkedIn', p.contact.linkedin),
    field('GitHub', p.contact.github),
    field('Website', p.contact.website),
    field('Work authorization', p.contact.workAuthorization),
    ...p.contact.other.filter((o) => o.label.trim()).map((o) => field(o.label, o.value))
  ])

  section(out, 'Summary', p.summary.trim() ? [p.summary.trim()] : [])

  section(
    out,
    'Skills',
    p.skills
      .filter((s) => s.category.trim() || s.items.length)
      .map((s) => field(s.category.trim() || 'Other', s.items.join(', ')))
  )

  entries(out, 'Experience', p.experience, (e) => [
    e.company,
    [
      opt('Role', e.role),
      opt('Start', e.start),
      opt('End', e.end),
      opt('Location', e.location),
      opt('Type', e.employmentType),
      opt('Project', e.project),
      opt('Project link', e.projectLink),
      opt('Technologies', e.technologies),
      list('Highlights', e.highlights)
    ]
  ])

  entries(out, 'Projects', p.projects, (e) => [
    e.name,
    [
      opt('Link', e.link),
      opt('Dates', e.dates),
      opt('Technologies', e.technologies),
      opt('Description', e.description),
      list('Highlights', e.highlights)
    ]
  ])

  entries(out, 'Education', p.education, (e) => [
    e.institution,
    [
      opt('Degree', e.degree),
      opt('Field', e.field),
      opt('Start', e.start),
      opt('End', e.end),
      opt('Location', e.location),
      opt('GPA', e.gpa),
      list('Highlights', e.highlights)
    ]
  ])

  entries(out, 'Certifications', p.certifications, (e) => [
    e.name,
    [opt('Issuer', e.issuer), opt('Date', e.date), opt('Link', e.link)]
  ])

  entries(out, 'Publications', p.publications, (e) => [
    e.title,
    [opt('Venue', e.venue), opt('Date', e.date), opt('Link', e.link), opt('Description', e.description)]
  ])

  section(
    out,
    GAPS_TITLE,
    p.gaps.map((g) => singleLine(g)).filter(Boolean).map((g) => `- ${g}`)
  )

  for (const extra of p.extraSections) {
    const title = singleLine(extra.title) || 'Notes'
    // A title that names a known section would be read back into that section.
    const safe = SECTION_ALIASES[normalizeKey(title)] ? `${title} (notes)` : title
    section(out, safe, extra.body.trim() ? [extra.body.trim()] : [])
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

const GAPS_TITLE = 'Gaps and constraints'

function section(out: string[], title: string, blocks: string[]): void {
  out.push(`## ${title}`, '')
  if (blocks.length) out.push(blocks.join('\n'), '')
}

function entries<T>(
  out: string[],
  title: string,
  items: T[],
  render: (item: T) => [heading: string, lines: Array<string | null>]
): void {
  out.push(`## ${title}`, '')
  for (const item of items) {
    const [heading, lines] = render(item)
    out.push(`### ${singleLine(heading)}`.trimEnd(), '')
    const body = lines.filter((l): l is string => l !== null)
    if (body.length) out.push(body.join('\n'), '')
  }
}

function field(label: string, value: string): string {
  return `- ${label}: ${singleLine(value)}`.trimEnd()
}

function opt(label: string, value: string): string | null {
  return value.trim() ? field(label, value) : null
}

function list(label: string, items: string[]): string | null {
  const clean = items.map(singleLine).filter(Boolean)
  if (!clean.length) return null
  return [`- ${label}:`, ...clean.map((i) => `  - ${i}`)].join('\n')
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ParseResult {
  profile: MasterProfile
  warnings: string[]
}

type SectionKind =
  | 'contact'
  | 'summary'
  | 'skills'
  | 'experience'
  | 'projects'
  | 'education'
  | 'certifications'
  | 'publications'
  | 'gaps'

const SECTION_ALIASES: Record<string, SectionKind> = {
  contact: 'contact',
  'contact information': 'contact',
  'contact info': 'contact',
  summary: 'summary',
  'professional summary': 'summary',
  profile: 'summary',
  about: 'summary',
  skills: 'skills',
  'technical skills': 'skills',
  experience: 'experience',
  'work experience': 'experience',
  'professional experience': 'experience',
  projects: 'projects',
  'personal projects': 'projects',
  education: 'education',
  certifications: 'certifications',
  certificates: 'certifications',
  publications: 'publications',
  'research and publications': 'publications',
  'gaps and constraints': 'gaps',
  gaps: 'gaps',
  constraints: 'gaps'
}

type EntryKind = 'experience' | 'projects' | 'education' | 'certifications' | 'publications'

/** Field aliases per entry kind → canonical key. Anything else is kept as a highlight / description. */
const FIELD_ALIASES: Record<EntryKind | 'contact', Record<string, string>> = {
  contact: {
    name: 'name',
    'full name': 'name',
    headline: 'headline',
    title: 'headline',
    'target title': 'headline',
    'target role': 'headline',
    location: 'location',
    city: 'location',
    email: 'email',
    'e mail': 'email',
    phone: 'phone',
    mobile: 'phone',
    telephone: 'phone',
    linkedin: 'linkedin',
    github: 'github',
    website: 'website',
    'personal website': 'website',
    homepage: 'website',
    'work authorization': 'workAuthorization',
    'work authorisation': 'workAuthorization'
  },
  experience: {
    company: 'company',
    employer: 'company',
    organization: 'company',
    role: 'role',
    title: 'role',
    position: 'role',
    start: 'start',
    from: 'start',
    end: 'end',
    to: 'end',
    until: 'end',
    dates: 'dates',
    period: 'dates',
    location: 'location',
    type: 'employmentType',
    'employment type': 'employmentType',
    project: 'project',
    'project link': 'projectLink',
    technologies: 'technologies',
    tech: 'technologies',
    'tech stack': 'technologies',
    stack: 'technologies',
    highlights: 'highlights',
    achievements: 'highlights',
    responsibilities: 'highlights'
  },
  projects: {
    name: 'name',
    link: 'link',
    url: 'link',
    repo: 'link',
    repository: 'link',
    github: 'link',
    dates: 'dates',
    date: 'dates',
    technologies: 'technologies',
    tech: 'technologies',
    'tech stack': 'technologies',
    stack: 'technologies',
    description: 'description',
    summary: 'description',
    highlights: 'highlights'
  },
  education: {
    institution: 'institution',
    school: 'institution',
    university: 'institution',
    degree: 'degree',
    field: 'field',
    major: 'field',
    'field of study': 'field',
    start: 'start',
    end: 'end',
    graduation: 'end',
    dates: 'dates',
    location: 'location',
    gpa: 'gpa',
    cgpa: 'gpa',
    highlights: 'highlights'
  },
  certifications: {
    name: 'name',
    issuer: 'issuer',
    'issued by': 'issuer',
    provider: 'issuer',
    date: 'date',
    year: 'date',
    issued: 'date',
    link: 'link',
    url: 'link',
    credential: 'link'
  },
  publications: {
    title: 'title',
    venue: 'venue',
    journal: 'venue',
    conference: 'venue',
    date: 'date',
    year: 'date',
    link: 'link',
    url: 'link',
    doi: 'link',
    description: 'description',
    summary: 'description'
  }
}

const LINK_KEYS = new Set(['linkedin', 'github', 'website', 'link', 'projectLink'])

/** One `###` entry (or a section body) before it is mapped onto a typed entry. */
interface RawEntry {
  heading: string
  line: number
  fields: Map<string, string>
  /** Top-level bullets without a known key, and nested items: they become highlights. */
  items: string[]
  /** Non-bullet text lines, with their 1-based line numbers. */
  text: Array<{ line: number; text: string }>
}

interface RawSection {
  kind: SectionKind
  title: string
  line: number
  /** Content before the first `###`. */
  body: RawEntry
  entries: RawEntry[]
}

const BULLET_RE = /^(\s*)[-*+•]\s+(.*)$/
const KEY_RE = /^(?:\*\*|__)?\s*([A-Za-z][A-Za-z0-9 &/'’.()-]{0,40}?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/

export function parseMasterProfile(markdown: string): ParseResult {
  const warnings: string[] = []
  const lines = stripComments(markdown.replace(/\r\n?/g, '\n'), warnings).split('\n')

  const sections: RawSection[] = []
  const extras: Array<{ title: string; lines: string[] }> = []
  let current: RawSection | null = null
  let extra: { title: string; lines: string[] } | null = null
  let entry: RawEntry | null = null
  // Where the next nested bullet or continuation line belongs.
  let lastList: { entry: RawEntry; key: string | null } | null = null

  lines.forEach((raw, index) => {
    const n = index + 1
    const h2 = /^##\s+(.*?)\s*#*\s*$/.exec(raw)
    if (h2 && !raw.startsWith('###')) {
      const kind = SECTION_ALIASES[normalizeKey(h2[1])]
      current = null
      extra = null
      entry = null
      lastList = null
      if (kind) {
        current = { kind, title: h2[1], line: n, body: rawEntry('', n), entries: [] }
        sections.push(current)
      } else {
        extra = { title: h2[1], lines: [] }
        extras.push(extra)
      }
      return
    }
    if (extra) {
      extra.lines.push(raw)
      return
    }
    if (!current) return // title and preamble: regenerated on save

    const section: RawSection = current
    const h3 = /^###\s*(.*?)\s*#*\s*$/.exec(raw)
    if (h3 && !raw.startsWith('####')) {
      entry = rawEntry(h3[1], n)
      section.entries.push(entry)
      lastList = null
      return
    }

    const target: RawEntry = entry ?? section.body
    if (!raw.trim()) {
      // Paragraph breaks matter in the summary; everywhere else blank lines are layout.
      if (section.kind === 'summary') target.text.push({ line: n, text: '' })
      return
    }

    const bullet = BULLET_RE.exec(raw)
    if (bullet) {
      const nested = bullet[1].replace(/\t/g, '  ').length >= 2
      const content = bullet[2].trim()
      if (nested && lastList && lastList.entry === target) {
        target.items.push(content)
        return
      }
      const kv = splitKey(content)
      const aliases = fieldAliasesFor(section.kind)
      const key = kv && aliases ? aliases[normalizeKey(kv.key)] : undefined
      if (kv && key) {
        if (key === 'highlights') {
          if (kv.value) target.items.push(kv.value)
          lastList = { entry: target, key }
        } else {
          target.fields.set(key, kv.value)
          lastList = { entry: target, key: null }
        }
        return
      }
      if (section.kind === 'contact' && kv) {
        target.fields.set(`other:${kv.key}`, kv.value)
        lastList = null
        return
      }
      target.items.push(content)
      lastList = { entry: target, key: null }
      return
    }

    // Indented plain text right after a bullet continues it.
    if (/^\s{2,}\S/.test(raw) && target.items.length && lastList?.entry === target) {
      target.items[target.items.length - 1] += ' ' + raw.trim()
      return
    }
    // Older profiles write fields without a bullet, e.g. "**Technologies:** Go".
    const kv = splitKey(raw.trim())
    const key = kv ? fieldAliasesFor(section.kind)?.[normalizeKey(kv.key)] : undefined
    if (kv && key && key !== 'highlights' && section.kind !== 'contact') {
      target.fields.set(key, kv.value)
    } else {
      target.text.push({ line: n, text: raw.trim() })
    }
    lastList = null
  })

  const profile = emptyProfile()
  for (const s of sections) applySection(profile, s, warnings)
  profile.extraSections = extras.map((e) => ({ title: e.title.trim(), body: trimBlankLines(e.lines).join('\n') }))
  return { profile, warnings }
}

function rawEntry(heading: string, line: number): RawEntry {
  return { heading: heading.trim(), line, fields: new Map(), items: [], text: [] }
}

function fieldAliasesFor(kind: SectionKind): Record<string, string> | null {
  switch (kind) {
    case 'contact':
    case 'experience':
    case 'projects':
    case 'education':
    case 'certifications':
    case 'publications':
      return FIELD_ALIASES[kind]
    default:
      return null
  }
}

function splitKey(text: string): { key: string; value: string } | null {
  const m = KEY_RE.exec(text)
  if (!m) return null
  return { key: m[1].trim(), value: m[2].replace(/^(\*\*|__)\s*/, '').trim() }
}

/** Removes `<!-- -->` blocks, keeping line numbers stable. Comments after the header are reported. */
function stripComments(text: string, warnings: string[]): string {
  const firstSection = text.search(/^##\s/m)
  return text.replace(/<!--[\s\S]*?-->/g, (match, offset: number) => {
    if (firstSection !== -1 && offset > firstSection) {
      const line = text.slice(0, offset).split('\n').length
      warnings.push(`Line ${line}: HTML comments are not kept when saving from Huntgry.`)
    }
    return match.replace(/[^\n]/g, '')
  })
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start++
  while (end > start && !lines[end - 1].trim()) end--
  return lines.slice(start, end)
}

function notKept(warnings: string[], section: RawSection, t: { line: number; text: string }): void {
  const snippet = t.text.length > 60 ? `${t.text.slice(0, 57)}...` : t.text
  warnings.push(
    `Line ${t.line} (${section.title}): "${snippet}" was not recognised and is not kept when saving from Huntgry.`
  )
}

function applySection(profile: MasterProfile, s: RawSection, warnings: string[]): void {
  switch (s.kind) {
    case 'contact':
      applyContact(profile.contact, s, warnings)
      return
    case 'summary': {
      const text = [...s.body.text.map((t) => t.text), ...s.body.items.map((i) => `- ${i}`)]
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      profile.summary = [profile.summary, text].filter(Boolean).join('\n\n')
      return
    }
    case 'skills':
      for (const item of s.body.items) {
        const kv = splitKey(item)
        profile.skills.push(
          kv && kv.value
            ? { category: kv.key, items: splitList(kv.value) }
            : { category: 'Other', items: splitList(item) }
        )
      }
      s.body.text.forEach((t) => notKept(warnings, s, t))
      warnOrphans(s, warnings)
      return
    case 'gaps':
      profile.gaps.push(...s.body.items, ...s.body.text.map((t) => t.text))
      warnOrphans(s, warnings)
      return
    case 'experience':
      profile.experience.push(...s.entries.map((e) => toExperience(e, s, warnings)))
      warnLoose(s, warnings)
      return
    case 'projects':
      profile.projects.push(...s.entries.map((e) => toProject(e)))
      warnLoose(s, warnings)
      return
    case 'education':
      profile.education.push(...s.entries.map((e) => toEducation(e, s, warnings)))
      warnLoose(s, warnings)
      return
    case 'certifications':
      profile.certifications.push(...s.entries.map((e) => toCertification(e, s, warnings)))
      // Older profiles list certifications as plain bullets: one entry per bullet.
      profile.certifications.push(...s.body.items.map((i) => bulletCertification(i)))
      s.body.text.forEach((t) => notKept(warnings, s, t))
      return
    case 'publications':
      profile.publications.push(...s.entries.map((e) => toPublication(e)))
      profile.publications.push(
        ...s.body.items.map((i) => ({ ...emptyPublication(), title: i, link: linkValue(i) === i ? '' : linkValue(i) }))
      )
      s.body.text.forEach((t) => notKept(warnings, s, t))
      return
  }
}

/** `###` entries in a section that has none. */
function warnOrphans(s: RawSection, warnings: string[]): void {
  for (const e of s.entries) {
    notKept(warnings, s, { line: e.line, text: `### ${e.heading}` })
    e.items.forEach((i) => notKept(warnings, s, { line: e.line, text: i }))
    e.text.forEach((t) => notKept(warnings, s, t))
  }
}

/** Content before the first `###` in an entry section. */
function warnLoose(s: RawSection, warnings: string[]): void {
  for (const [key, value] of s.body.fields) notKept(warnings, s, { line: s.line, text: `${key}: ${value}` })
  s.body.items.forEach((i) => notKept(warnings, s, { line: s.line, text: i }))
  s.body.text.forEach((t) => notKept(warnings, s, t))
}

function applyContact(c: ContactInfo, s: RawSection, warnings: string[]): void {
  const all = [s.body, ...s.entries]
  for (const e of all) {
    for (const [key, value] of e.fields) {
      if (key.startsWith('other:')) {
        c.other.push({ label: key.slice('other:'.length), value })
        continue
      }
      const k = key as keyof Omit<ContactInfo, 'other'>
      c[k] = LINK_KEYS.has(key) ? linkValue(value) : value
    }
    e.items.forEach((i) => notKept(warnings, s, { line: e.line, text: i }))
    e.text.forEach((t) => notKept(warnings, s, t))
  }
}

function get(e: RawEntry, key: string): string {
  const v = e.fields.get(key) ?? ''
  return LINK_KEYS.has(key) ? (v ? linkValue(v) : '') : v
}

/** Nested Highlights items plus top-level bullets whose key is unknown, with their original text. */
function highlights(e: RawEntry): string[] {
  return e.items.slice()
}

function toExperience(e: RawEntry, s: RawSection, warnings: string[]): ExperienceEntry {
  const x: ExperienceEntry = {
    ...emptyExperience(),
    company: get(e, 'company') || e.heading,
    role: get(e, 'role'),
    start: get(e, 'start'),
    end: get(e, 'end'),
    location: get(e, 'location'),
    employmentType: get(e, 'employmentType'),
    project: get(e, 'project'),
    projectLink: get(e, 'projectLink'),
    technologies: get(e, 'technologies'),
    highlights: highlights(e)
  }
  applyDates(x, get(e, 'dates'))
  // Older profiles: "### Company - Job Title" with a "YYYY - Present | City" line.
  if (!x.role && !e.fields.has('company')) {
    const parts = e.heading.split(/\s+[-–—]\s+|\s+@\s+/)
    if (parts.length === 2) [x.company, x.role] = parts.map((p) => p.trim())
  }
  // Older "Project link: Name - https://..." lines carry the project name too.
  const rawLink = e.fields.get('projectLink')
  if (rawLink && !x.project) {
    const name = tidy(rawLink.replace(/\(link:[^)]*\)/i, '').replace(x.projectLink, ''))
    if (name && name !== rawLink.trim()) x.project = name
  }
  for (const t of e.text) {
    if (!x.start && !x.end && applyDateLine(x, t.text)) continue
    notKept(warnings, s, t)
  }
  return x
}

function toProject(e: RawEntry): ProjectEntry {
  const text = e.text.map((t) => t.text)
  // Older profiles put the repo URL on its own line.
  let link = get(e, 'link')
  const rest: string[] = []
  for (const t of text) {
    if (!link && linkValue(t) !== t) link = linkValue(t)
    else rest.push(t)
  }
  return {
    ...emptyProject(),
    name: get(e, 'name') || e.heading,
    link,
    dates: get(e, 'dates'),
    technologies: get(e, 'technologies'),
    description: [get(e, 'description'), ...rest].filter(Boolean).join(' '),
    highlights: highlights(e)
  }
}

function toEducation(e: RawEntry, s: RawSection, warnings: string[]): EducationEntry {
  const x: EducationEntry = {
    ...emptyEducation(),
    institution: get(e, 'institution') || e.heading,
    degree: get(e, 'degree'),
    field: get(e, 'field'),
    start: get(e, 'start'),
    end: get(e, 'end'),
    location: get(e, 'location'),
    gpa: get(e, 'gpa'),
    highlights: highlights(e)
  }
  applyDates(x, get(e, 'dates'))
  for (const t of e.text) {
    // Older profiles: "Degree, Field, YYYY" on one line.
    if (!x.degree) {
      const d = extractDates(t.text, true)
      const parts = (d ? d.rest : t.text).split(/,\s*/)
      x.degree = parts[0]?.trim() ?? ''
      if (!x.field && parts.length > 1) x.field = parts.slice(1).join(', ').trim()
      if (d && !x.end) [x.start, x.end] = [d.start, d.end]
      continue
    }
    notKept(warnings, s, t)
  }
  return x
}

function toCertification(e: RawEntry, s: RawSection, warnings: string[]): CertificationEntry {
  e.items.forEach((i) => notKept(warnings, s, { line: e.line, text: i }))
  e.text.forEach((t) => notKept(warnings, s, t))
  return {
    ...emptyCertification(),
    name: get(e, 'name') || e.heading,
    issuer: get(e, 'issuer'),
    date: get(e, 'date'),
    link: get(e, 'link')
  }
}

function bulletCertification(text: string): CertificationEntry {
  const d = extractDates(text, true)
  const base = d ? d.rest : text
  const parts = base.split(/,\s*/)
  return {
    ...emptyCertification(),
    name: parts[0].trim(),
    issuer: parts.slice(1).join(', ').trim(),
    date: d ? d.end : ''
  }
}

function toPublication(e: RawEntry): PublicationEntry {
  return {
    ...emptyPublication(),
    title: get(e, 'title') || e.heading,
    venue: get(e, 'venue'),
    date: get(e, 'date'),
    link: get(e, 'link'),
    description: [get(e, 'description'), ...e.items, ...e.text.map((t) => t.text)].filter(Boolean).join(' ')
  }
}

function applyDates(x: { start: string; end: string }, dates: string): void {
  if (!dates || x.start || x.end) return
  const d = extractDates(dates, true)
  if (d) [x.start, x.end] = [d.start, d.end]
  else x.start = dates
}

function applyDateLine(x: ExperienceEntry, line: string): boolean {
  const d = extractDates(line)
  if (!d) return false
  x.start = d.start
  x.end = d.end
  if (!x.location && d.rest) x.location = d.rest.split('|').map((p) => p.trim()).filter(Boolean).join(', ')
  return true
}
