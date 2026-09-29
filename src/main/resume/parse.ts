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
  type ProjectEntry
} from '@shared/master-profile'
import { extractDates, findUrl, hasDateRange, normalizeKey, splitList, tidy, unshout } from '../profile/text'
import type { ResumeLine } from './types'

/**
 * Turns the lines of a typical single-column resume into a draft master
 * profile. Deterministic heuristics only (section headings, date ranges,
 * tab-separated columns, bullets); nothing leaves the machine. The draft is
 * always shown to the user for review before it is saved.
 */

type Kind = 'summary' | 'skills' | 'experience' | 'projects' | 'education' | 'certifications' | 'publications'

const HEADINGS: Record<string, Kind> = {
  summary: 'summary',
  'professional summary': 'summary',
  'career summary': 'summary',
  profile: 'summary',
  'professional profile': 'summary',
  about: 'summary',
  'about me': 'summary',
  objective: 'summary',
  'career objective': 'summary',
  skills: 'skills',
  'technical skills': 'skills',
  'core skills': 'skills',
  'key skills': 'skills',
  'core competencies': 'skills',
  competencies: 'skills',
  technologies: 'skills',
  'skills and tools': 'skills',
  'skills and technologies': 'skills',
  experience: 'experience',
  'work experience': 'experience',
  'professional experience': 'experience',
  'relevant experience': 'experience',
  employment: 'experience',
  'employment history': 'experience',
  'work history': 'experience',
  'career history': 'experience',
  projects: 'projects',
  'personal projects': 'projects',
  'selected projects': 'projects',
  'side projects': 'projects',
  'academic projects': 'projects',
  'key projects': 'projects',
  education: 'education',
  'academic background': 'education',
  'education and training': 'education',
  certifications: 'certifications',
  certificates: 'certifications',
  certification: 'certifications',
  'licenses and certifications': 'certifications',
  'certifications and licenses': 'certifications',
  publications: 'publications',
  research: 'publications',
  'research and publications': 'publications',
  'publications and research': 'publications',
  papers: 'publications'
}

/** Keywords for ALL-CAPS headings that are not in the list above, e.g. "RELEVANT WORK EXPERIENCE". */
const HEADING_KEYWORDS: Array<[RegExp, Kind]> = [
  [/experience|employment|work history/, 'experience'],
  [/education|academic/, 'education'],
  [/project/, 'projects'],
  [/skill|competenc/, 'skills'],
  [/certif|licen/, 'certifications'],
  [/publication|research|paper/, 'publications'],
  [/summary|profile|objective/, 'summary']
]

const ROLE_RE =
  /\b(engineer|developer|programmer|manager|intern|analyst|scientist|designer|lead|architect|consultant|researcher|specialist|director|officer|assistant|associate|administrator|technician|founder|co-?founder|head|vp|president|coordinator|teacher|instructor|professor|fellow|contractor|freelancer|sde|swe)\b/i
const EMPLOYMENT_TYPE_RE =
  /^(?:(?:full|part)[- ]?time|remote|hybrid|on[- ]?site|contract(?:or)?|freelance|internship|temporary|seasonal|volunteer)(?:\s*[,/&]\s*(?:(?:full|part)[- ]?time|remote|hybrid|on[- ]?site|contract(?:or)?|freelance|internship|temporary|seasonal|volunteer))*$/i
const TYPE_PREFIX_RE = /^((?:full|part)[- ]?time|remote|hybrid|on[- ]?site|contract|internship)[\s,]+/i
const LOCATION_RE = /^[\p{Lu}][\p{L} .'’-]{1,40},\s*[\p{Lu}][\p{L} .'’-]{1,40}$/u
const DEGREE_RE =
  /\b(bachelor|master|doctor|ph\.?\s?d|mba|associate(?:'s)? degree|diploma|high school|b\.?\s?sc?\.?|m\.?\s?sc?\.?|b\.?\s?a\.?|m\.?\s?a\.?|b\.?\s?e\.?|m\.?\s?e\.?|b\.?\s?tech|m\.?\s?tech|m\.?\s?eng|b\.?\s?eng)\b/i
const INSTITUTION_RE = /\b(university|college|institute|school|academy|polytechnic|campus|universit[äa]t|école)\b/i
const LINK_LABEL_RE = /^(github|git|link|demo|live|live demo|website|site|repo|source|code|app|paper|arxiv|doi)$/i
const FIELD_LINE_RE = /^(project|projects|technologies|tech stack|tech|stack|environment|tools|key technologies)\s*:\s*(.+)$/i
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/
const PHONE_RE = /\+?\(?\d[\d\s().-]{6,}\d/

export interface ParsedResume {
  profile: MasterProfile
  warnings: string[]
}

export function parseResume(input: ResumeLine[]): ParsedResume {
  const lines = input
    .map((l) => ({ ...l, text: l.text.replace(/ /g, ' ').replace(/[ ]+/g, ' ').replace(/^\s+|\s+$/g, '') }))
    .filter((l) => l.text)
  const profile = emptyProfile()
  const warnings: string[] = []

  const header: ResumeLine[] = []
  const sections: Array<{ kind: Kind | null; title: string; lines: ResumeLine[] }> = []
  for (const line of lines) {
    const heading = headingOf(line)
    // An ALL-CAPS line before the first known heading is the name or a tagline, not a section.
    if (heading && (heading.kind !== null || sections.length)) {
      sections.push({ kind: heading.kind, title: heading.title, lines: [] })
    } else if (sections.length) {
      sections[sections.length - 1].lines.push(line)
    } else {
      header.push(line)
    }
  }

  parseHeader(header, profile)

  for (const s of sections) {
    switch (s.kind) {
      case 'summary':
        profile.summary = [profile.summary, s.lines.map((l) => l.text).join(' ')].filter(Boolean).join('\n\n')
        break
      case 'skills':
        parseSkills(s.lines, profile)
        break
      case 'experience':
        profile.experience.push(...blocks(s.lines).map(toExperience))
        break
      case 'projects':
        profile.projects.push(...blocks(s.lines).map(toProject))
        break
      case 'education':
        profile.education.push(...blocks(s.lines).map(toEducation))
        break
      case 'certifications':
        profile.certifications.push(...parseCertifications(s.lines))
        break
      case 'publications':
        profile.publications.push(
          ...mergeContinuations(s.lines).map((l) => ({
            ...emptyPublication(),
            title: l.text,
            link: l.links[0] ?? findUrl(l.text) ?? ''
          }))
        )
        break
      case null:
        if (s.lines.length) {
          profile.extraSections.push({
            title: s.title,
            body: mergeContinuations(s.lines)
              .map((l) => (l.bullet ? `- ${l.text}` : l.text))
              .join('\n')
          })
        }
        break
    }
  }

  inferHeadline(profile)
  if (!profile.contact.name) warnings.push('Could not find your name at the top of the resume.')
  if (!sections.length) {
    warnings.push('No resume sections (Experience, Education, Skills...) were recognised. Fill the profile in by hand.')
  } else if (!profile.experience.length) {
    warnings.push('No work experience was recognised.')
  }
  const untitled = sections.filter((s) => s.kind === null && s.lines.length).map((s) => s.title)
  if (untitled.length) warnings.push(`Kept as extra sections: ${untitled.join(', ')}.`)
  return { profile, warnings }
}

function headingOf(line: ResumeLine): { kind: Kind | null; title: string } | null {
  if (line.bullet || line.text.includes('\t') || line.text.length > 50) return null
  const text = line.text.replace(/[:：]\s*$/, '').trim()
  const key = normalizeKey(text)
  if (!key) return null
  const kind = HEADINGS[key]
  if (kind) return { kind, title: unshout(text) }
  const letters = text.replace(/[^\p{L}]/gu, '')
  const shouting = letters.length >= 4 && letters === letters.toUpperCase() && !/\d/.test(text)
  if (!shouting || text.split(/\s+/).length > 5 || /[|@,]/.test(text)) return null
  for (const [re, k] of HEADING_KEYWORDS) if (re.test(key)) return { kind: k, title: unshout(text) }
  return { kind: null, title: unshout(text) }
}

// ---------------------------------------------------------------------------
// Header: name, headline, contact details
// ---------------------------------------------------------------------------

function parseHeader(header: ResumeLine[], profile: MasterProfile): void {
  const c = profile.contact
  const summary: string[] = []
  header.forEach((line, i) => {
    for (const url of line.links) applyLink(c, url)
    const tokens = line.text.split(/\t+|\s+[|•·◆♦]\s+|\s{2,}/).map(tidy).filter(Boolean)
    if (i === 0 && !EMAIL_RE.test(tokens[0] ?? '') && (tokens[0]?.split(/\s+/).length ?? 0) <= 5) {
      c.name = unshout(tokens.shift() ?? '')
    }
    for (const token of tokens) {
      if (token.split(/\s+/).length > 12) {
        summary.push(token)
        continue
      }
      classifyContactToken(c, token)
    }
  })
  if (summary.length) profile.summary = summary.join(' ')
}

function classifyContactToken(c: ContactInfo, token: string): void {
  const email = EMAIL_RE.exec(token)
  if (email) {
    c.email ||= email[0]
    return
  }
  const url = findUrl(token)
  if (url) {
    applyLink(c, url)
    return
  }
  if (PHONE_RE.test(token) && token.replace(/\D/g, '').length >= 7) {
    c.phone ||= token
    return
  }
  if (LINK_LABEL_RE.test(token) || /^(linkedin|portfolio)$/i.test(token)) return
  if (LOCATION_RE.test(token) && !ROLE_RE.test(token)) {
    c.location ||= token
    return
  }
  if (!c.headline && /\p{L}/u.test(token)) c.headline = token
}

function applyLink(c: ContactInfo, url: string): void {
  const lower = url.toLowerCase()
  if (lower.startsWith('mailto:')) {
    c.email ||= url.slice('mailto:'.length).split('?')[0]
  } else if (lower.startsWith('tel:')) {
    c.phone ||= url.slice('tel:'.length)
  } else if (lower.includes('linkedin.com')) {
    c.linkedin ||= withScheme(url)
  } else if (lower.includes('github.com')) {
    c.github ||= withScheme(url)
  } else {
    c.website ||= withScheme(url)
  }
}

/** "Full-Stack Software Engineer with 5+ years..." → headline "Full-Stack Software Engineer". */
function inferHeadline(profile: MasterProfile): void {
  if (profile.contact.headline) return
  const m = /^((?:[\p{L}][\p{L}/&.+-]*\s+){0,5}[\p{L}][\p{L}/&.+-]*)\s+(?:with|having)\s+\d/u.exec(profile.summary)
  if (m && ROLE_RE.test(m[1])) profile.contact.headline = m[1].replace(/^(?:an?|experienced|seasoned)\s+/i, '')
}

function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

// ---------------------------------------------------------------------------
// Skills, certifications
// ---------------------------------------------------------------------------

function parseSkills(lines: ResumeLine[], profile: MasterProfile): void {
  let loose: string[] = []
  for (const line of mergeContinuations(lines)) {
    for (const part of line.text.split(/\t+/)) {
      const kv = /^([^:]{1,48}):\s*(.+)$/.exec(part)
      if (kv) profile.skills.push({ category: tidy(kv[1]), items: splitList(kv[2]) })
      else loose = loose.concat(splitList(part.replace(/\s[|•·]\s/g, ', ')))
    }
  }
  if (loose.length) profile.skills.push({ category: 'Skills', items: loose })
}

function parseCertifications(lines: ResumeLine[]): CertificationEntry[] {
  const out: CertificationEntry[] = []
  for (const line of mergeContinuations(lines)) {
    const parts = line.text.split(/\t+|\s+[|•·]\s+/).map(tidy).filter(Boolean)
    for (const part of parts) {
      const d = extractDates(part, true)
      const text = d ? d.rest : part
      const [name, ...issuer] = text.split(/\s+[–—-]\s+|,\s+(?=[^,]+$)/)
      out.push({
        ...emptyCertification(),
        name: tidy(name),
        issuer: tidy(issuer.join(' ')),
        date: d?.end ?? '',
        link: parts.length === 1 ? (line.links[0] ?? '') : ''
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Entry blocks: experience, projects, education
// ---------------------------------------------------------------------------

interface Block {
  header: ResumeLine[]
  fields: ResumeLine[]
  bullets: ResumeLine[]
}

const CONTINUATION_END_RE = /(?:[,;:(–—-]|\b(?:and|or|of|the|to|with|for|in|on|a|an|by|from|across))$/i

function isContinuation(line: ResumeLine, previous: ResumeLine | undefined): boolean {
  if (!previous?.bullet || line.bullet || line.text.includes('\t') || hasDateRange(line.text)) return false
  return /^[\p{Ll}(]/u.test(line.text) || CONTINUATION_END_RE.test(previous.text)
}

/** Wrapped lines of a bullet (plain text resumes) are joined back onto it. */
function mergeContinuations(lines: ResumeLine[]): ResumeLine[] {
  const out: ResumeLine[] = []
  for (const line of lines) {
    const last = out[out.length - 1]
    if (isContinuation(line, last)) {
      out[out.length - 1] = { ...last, text: `${last.text} ${line.text}`, links: [...last.links, ...line.links] }
    } else {
      out.push({ ...line, links: [...line.links] })
    }
  }
  return out
}

/**
 * Groups lines into entries: one or more header lines (company, role, dates),
 * then bullets. A header line after bullets, or a second date range, starts
 * the next entry. "Project: ..." / "Tech: ..." lines stay with the current one.
 */
function blocks(lines: ResumeLine[]): Block[] {
  const out: Block[] = []
  let block: Block | null = null
  for (const line of mergeContinuations(lines)) {
    if (line.bullet) {
      if (!block) out.push((block = { header: [], fields: [], bullets: [] }))
      block.bullets.push(line)
      continue
    }
    if (block && FIELD_LINE_RE.test(line.text)) {
      block.fields.push(line)
      continue
    }
    const startNew =
      !block ||
      block.bullets.length > 0 ||
      block.fields.length > 0 ||
      (hasDateRange(line.text) && block.header.some((h) => hasDateRange(h.text)))
    if (startNew) out.push((block = { header: [], fields: [], bullets: [] }))
    block!.header.push(line)
  }
  return out
}

/** Header lines split into their columns, with the first date range pulled out. */
function headerParts(block: Block, allowSingleDate: boolean): { parts: string[]; start: string; end: string } {
  let start = ''
  let end = ''
  const parts: string[] = []
  for (const line of block.header) {
    let text = line.text
    if (!start && !end) {
      const d = extractDates(text, false) ?? (allowSingleDate ? extractDates(text, true) : null)
      if (d) {
        ;({ start, end } = d)
        text = d.rest
      }
    }
    parts.push(...text.split(/\t+|\s{2,}|\s+\|\s+/).map(tidy).filter(Boolean))
  }
  return { parts, start, end }
}

function toExperience(block: Block): ExperienceEntry {
  const x = emptyExperience()
  const { parts, start, end } = headerParts(block, true)
  x.start = start
  x.end = end

  const types: string[] = []
  const locations: string[] = []
  const rest: string[] = []
  for (let part of parts) {
    // "Part-Time Huntsville, AL" when the column gap was lost: peel the type off the front.
    const lead = TYPE_PREFIX_RE.exec(part)
    if (lead && lead[0].length < part.length) {
      types.push(lead[1])
      part = part.slice(lead[0].length)
    }
    if (EMPLOYMENT_TYPE_RE.test(part)) types.push(part)
    else if (!ROLE_RE.test(part) && LOCATION_RE.test(part)) locations.push(part)
    else rest.push(part)
  }
  const roleIndex = rest.findIndex((p) => ROLE_RE.test(p))
  if (rest.length === 1 && roleIndex === 0) {
    // "Role at Company" / "Role — Company" / "Company — Role" on one line.
    const split = rest[0].split(/\s+(?:at|@)\s+|\s+[–—-]\s+|,\s+/)
    if (split.length === 2) {
      const [a, b] = split
      ;[x.role, x.company] = ROLE_RE.test(a) && !ROLE_RE.test(b) ? [a, b] : ROLE_RE.test(b) ? [b, a] : [a, b]
    } else {
      x.role = rest[0]
    }
  } else if (roleIndex >= 0) {
    x.role = rest[roleIndex]
    x.company = rest.find((_p, i) => i !== roleIndex) ?? ''
  } else {
    ;[x.company = '', x.role = ''] = rest
  }
  x.location = locations[0] ?? ''
  x.employmentType = types.join(', ')

  for (const f of block.fields) {
    const m = FIELD_LINE_RE.exec(f.text)!
    if (/^projects?$/i.test(m[1])) {
      x.project = x.project ? `${x.project}; ${tidy(m[2])}` : tidy(m[2])
      x.projectLink ||= f.links[0] ?? findUrl(m[2]) ?? ''
    } else {
      x.technologies = x.technologies ? `${x.technologies}, ${tidy(m[2])}` : tidy(m[2])
    }
  }
  x.highlights = block.bullets.map((b) => b.text)
  return x
}

function toProject(block: Block): ProjectEntry {
  const x = emptyProject()
  const [first, ...more] = block.header
  if (first) {
    const d = extractDates(first.text, true)
    if (d && (d.start || /\d{4}/.test(d.end))) x.dates = d.start ? `${d.start} – ${d.end}` : d.end
    const parts = (d && x.dates ? d.rest : first.text).split(/\t+|\s+\|\s+/).map(tidy).filter(Boolean)
    x.name = parts.shift() ?? ''
    for (const part of parts) {
      if (LINK_LABEL_RE.test(part) || findUrl(part) === part) continue
      if (part.includes(',')) x.technologies = part
      else x.description = [x.description, part].filter(Boolean).join(' ')
    }
    x.link = first.links[0] ?? findUrl(first.text) ?? ''
  }
  x.description = [x.description, ...more.map((l) => l.text)].filter(Boolean).join(' ')
  for (const f of block.fields) {
    const m = FIELD_LINE_RE.exec(f.text)!
    if (/^projects?$/i.test(m[1])) x.description = [x.description, tidy(m[2])].filter(Boolean).join(' ')
    else x.technologies = x.technologies ? `${x.technologies}, ${tidy(m[2])}` : tidy(m[2])
    x.link ||= f.links[0] ?? ''
  }
  x.highlights = block.bullets.map((b) => b.text)
  if (!x.name && x.highlights.length) x.name = x.highlights.shift() ?? ''
  return x
}

function toEducation(block: Block): EducationEntry {
  const x = emptyEducation()
  const { parts, start, end } = headerParts(block, true)
  x.start = start
  x.end = end
  const rest: string[] = []
  for (let part of parts) {
    const gpa = /\b(?:c?gpa)\s*[:\s]\s*([\d.]+(?:\s*\/\s*[\d.]+)?)/i.exec(part)
    if (gpa) {
      x.gpa = gpa[1].replace(/\s+/g, '')
      part = tidy(part.replace(gpa[0], ''))
      if (!part) continue
    }
    if (!x.degree && DEGREE_RE.test(part) && !INSTITUTION_RE.test(part)) {
      const [degree, ...field] = part.split(/,\s*|\s+in\s+/)
      x.degree = tidy(degree)
      x.field = tidy(field.join(', '))
    } else if (!x.institution && INSTITUTION_RE.test(part)) {
      x.institution = part
    } else if (!x.location && LOCATION_RE.test(part)) {
      x.location = part
    } else {
      rest.push(part)
    }
  }
  if (!x.institution && rest.length) x.institution = rest.shift() ?? ''
  if (!x.degree && rest.length) x.degree = rest.shift() ?? ''
  x.highlights = [...rest, ...block.fields.map((f) => f.text), ...block.bullets.map((b) => b.text)]
  return x
}
