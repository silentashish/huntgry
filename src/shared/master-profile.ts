/**
 * The master profile as the app sees it. The Markdown file in the workspace
 * (`master-profile.md`) stays the single source of truth; this is its parsed
 * form, produced and consumed only by `src/main/profile/format.ts`.
 * Types and pure helpers only: nothing in here may touch the filesystem.
 */

export interface ContactInfo {
  name: string
  /** Target title shown under the name, e.g. "Full-Stack Software Engineer". */
  headline: string
  location: string
  email: string
  phone: string
  linkedin: string
  github: string
  website: string
  workAuthorization: string
  /** Any other `- Label: value` lines (portfolio, Twitter, ...), kept in order. */
  other: LabeledValue[]
}

export interface LabeledValue {
  label: string
  value: string
}

export interface SkillGroup {
  /** e.g. "Languages & Frameworks". */
  category: string
  /** Comma-separated in the file, one item per entry here. */
  items: string[]
}

export interface ExperienceEntry {
  company: string
  role: string
  start: string
  end: string
  location: string
  /** Free text such as "Part-Time, Remote". */
  employmentType: string
  project: string
  projectLink: string
  technologies: string
  highlights: string[]
}

export interface ProjectEntry {
  name: string
  link: string
  dates: string
  technologies: string
  description: string
  highlights: string[]
}

export interface EducationEntry {
  institution: string
  degree: string
  field: string
  start: string
  end: string
  location: string
  gpa: string
  /** Thesis, honours, relevant coursework... */
  highlights: string[]
}

export interface CertificationEntry {
  name: string
  issuer: string
  date: string
  link: string
}

export interface PublicationEntry {
  title: string
  venue: string
  date: string
  link: string
  description: string
}

/** A `##` section the app does not know. Kept verbatim so hand edits survive a save from the app. */
export interface ExtraSection {
  title: string
  body: string
}

export interface MasterProfile {
  contact: ContactInfo
  summary: string
  skills: SkillGroup[]
  experience: ExperienceEntry[]
  projects: ProjectEntry[]
  education: EducationEntry[]
  certifications: CertificationEntry[]
  publications: PublicationEntry[]
  /** What you do not have or cannot do, so the generator never papers over it. */
  gaps: string[]
  extraSections: ExtraSection[]
}

/** Result of reading the master profile of the current workspace. */
export interface ProfileDocument {
  /** Absolute path of the Markdown file. */
  path: string
  profile: MasterProfile
  /** Opaque content hash; pass it back on save to detect edits made on disk meanwhile. */
  version: string
  /** Lines the parser could not place. They are not kept when saving from the app. */
  warnings: string[]
}

export type SaveProfileResult =
  | { ok: true; document: ProfileDocument }
  | { ok: false; conflict: boolean; error: string }

export type ResumeImportResult =
  | { ok: true; fileName: string; profile: MasterProfile; warnings: string[] }
  | { ok: false; cancelled: boolean; error?: string }

export function emptyContact(): ContactInfo {
  return {
    name: '',
    headline: '',
    location: '',
    email: '',
    phone: '',
    linkedin: '',
    github: '',
    website: '',
    workAuthorization: '',
    other: []
  }
}

export function emptyProfile(): MasterProfile {
  return {
    contact: emptyContact(),
    summary: '',
    skills: [],
    experience: [],
    projects: [],
    education: [],
    certifications: [],
    publications: [],
    gaps: [],
    extraSections: []
  }
}

export function emptyExperience(): ExperienceEntry {
  return {
    company: '',
    role: '',
    start: '',
    end: '',
    location: '',
    employmentType: '',
    project: '',
    projectLink: '',
    technologies: '',
    highlights: []
  }
}

export function emptyProject(): ProjectEntry {
  return { name: '', link: '', dates: '', technologies: '', description: '', highlights: [] }
}

export function emptyEducation(): EducationEntry {
  return { institution: '', degree: '', field: '', start: '', end: '', location: '', gpa: '', highlights: [] }
}

export function emptyCertification(): CertificationEntry {
  return { name: '', issuer: '', date: '', link: '' }
}

export function emptyPublication(): PublicationEntry {
  return { title: '', venue: '', date: '', link: '', description: '' }
}

/** True when nothing has been filled in yet (a freshly created workspace). */
export function isProfileEmpty(p: MasterProfile): boolean {
  const { other, ...contact } = p.contact
  return (
    Object.values(contact).every((v) => v.trim() === '') &&
    other.length === 0 &&
    p.summary.trim() === '' &&
    p.skills.length === 0 &&
    p.experience.length === 0 &&
    p.projects.length === 0 &&
    p.education.length === 0 &&
    p.certifications.length === 0 &&
    p.publications.length === 0 &&
    p.gaps.length === 0 &&
    p.extraSections.length === 0
  )
}
