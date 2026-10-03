import { opendir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  FILE_SCHEME,
  type ApplicationRecord,
  type ApplicationsList,
  type BuildSummary
} from '@shared/applications-types'
import { APPLICATION_DEPTH, APPLICATION_MARKERS, IGNORED_ENTRIES, MAX_SCAN_ENTRIES } from '../workspace/constants'
import { readTracking, TRACKING_FILE } from './tracking'

/**
 * Finds every `<role>/<company>/<job-id>/` application folder in a workspace
 * and summarizes it for the dashboard. Bounded like the workspace inspection:
 * at most `MAX_SCAN_ENTRIES` entries, symlinked directories are not followed.
 */

/** Files of an application folder the dashboard uses (open, preview, show). */
export const KNOWN_FILES = [
  'resume.pdf',
  'cover.pdf',
  'resume.docx',
  'job-description.md',
  'build-report.json',
  'resume_data.json',
  'cover_data.json',
  'resume.tex',
  'cover.tex',
  'review-notes.md'
] as const

const PAGE_IMAGE = /^(resume|cover)-page-(\d+)\.jpe?g$/

/** Files `openFile` may open and the file protocol may serve. */
export function isServableFile(name: string): boolean {
  return (KNOWN_FILES as readonly string[]).includes(name) || PAGE_IMAGE.test(name)
}

export async function scanApplications(workspace: string): Promise<ApplicationsList> {
  let visited = 0
  let truncated = false
  const folders: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      return
    }
    const subdirs: string[] = []
    let isApp = false
    for await (const e of handle) {
      if (++visited > MAX_SCAN_ENTRIES) {
        truncated = true
        break
      }
      if (IGNORED_ENTRIES.has(e.name) || e.name.startsWith('.')) continue
      if (depth === APPLICATION_DEPTH) {
        if (e.isFile() && APPLICATION_MARKERS.has(e.name)) isApp = true
      } else if (e.isDirectory()) {
        subdirs.push(join(dir, e.name))
      }
    }
    if (depth === APPLICATION_DEPTH) {
      if (isApp) folders.push(dir)
      return
    }
    for (const sub of subdirs) {
      if (truncated) return
      await walk(sub, depth + 1)
    }
  }

  await walk(workspace, 0)
  const records = await Promise.all(folders.map((f) => readApplication(workspace, f)))
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return { applications: records, truncated }
}

/** Summary of one application folder. Missing or broken files degrade to defaults, never throw. */
export async function readApplication(workspace: string, folder: string): Promise<ApplicationRecord> {
  const id = relative(workspace, folder).split(sep).join('/')
  const [role, company, jobId] = id.split('/')
  const names: string[] = []
  let created = Infinity
  let updated = 0
  try {
    for await (const e of await opendir(folder)) {
      if (!e.isFile()) continue
      names.push(e.name)
      if (isServableFile(e.name) || e.name === TRACKING_FILE) {
        const s = await stat(join(folder, e.name)).catch(() => null)
        if (s) {
          created = Math.min(created, s.birthtimeMs || s.mtimeMs)
          // Tracking edits are not "the application changed".
          if (e.name !== TRACKING_FILE) updated = Math.max(updated, s.mtimeMs)
        }
      }
    }
  } catch {
    // unreadable folder: report what we have
  }
  if (!Number.isFinite(created)) created = updated
  const [jd, report, tracking] = await Promise.all([
    // `names` holds regular files only (Dirent.isFile is false for symlinks), so a symlinked file is never read.
    names.includes('job-description.md') ? readText(join(folder, 'job-description.md')) : null,
    names.includes('build-report.json') ? readText(join(folder, 'build-report.json')) : null,
    readTracking(folder)
  ])
  const pages = (kind: 'resume' | 'cover') =>
    names
      .map((n) => PAGE_IMAGE.exec(n))
      .filter((m): m is RegExpExecArray => m !== null && m[1] === kind)
      .sort((a, b) => Number(a[2]) - Number(b[2]))
      .map((m) => m[0])

  return {
    id,
    role: humanize(role),
    company: humanize(company),
    jobId,
    jobTitle: jd ? jobTitleOf(jd) : '',
    jobUrl: tracking.jobUrl ?? (jd ? postingUrl(jd) : null),
    createdAt: new Date(created || 0).toISOString(),
    updatedAt: new Date(updated || created || 0).toISOString(),
    files: names.filter((n) => (KNOWN_FILES as readonly string[]).includes(n)).sort(),
    resumePages: pages('resume'),
    coverPages: pages('cover'),
    build: summarizeBuild(report),
    tracking
  }
}

async function readText(path: string, max = 512 * 1024): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length > max ? text.slice(0, max) : text
  } catch {
    return null
  }
}

/** Words that read as acronyms in role and company slugs. */
const ACRONYMS = new Set([
  'ml',
  'ai',
  'sre',
  'qa',
  'ui',
  'ux',
  'api',
  'aws',
  'gcp',
  'it',
  'hr',
  'vp',
  'cto',
  'ceo',
  'ios',
  'nlp',
  'llm',
  'sdet',
  'devops',
  'ibm',
  'uk',
  'us'
])

/** `software-engineer` → `Software Engineer`; keeps anything that is not a slug as it is. */
export function humanize(slug: string | undefined): string {
  if (!slug) return ''
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug)) return slug
  return slug
    .split(/[-_]/)
    .map((w) =>
      ACRONYMS.has(w)
        ? w === 'devops'
          ? 'DevOps'
          : w === 'ios'
            ? 'iOS'
            : w.toUpperCase()
        : w[0].toUpperCase() + w.slice(1)
    )
    .join(' ')
}

/** First Markdown heading, else the first non-empty line, trimmed to a title's length. */
export function jobTitleOf(markdown: string): string {
  const lines = markdown.split('\n').map((l) => l.trim())
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l))
  const line = heading ?? lines.find((l) => l && !/^(---|\*\*\*|<!--)/.test(l)) ?? ''
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .slice(0, 140)
}

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g
const clean = (url: string) => url.replace(/[.,;:!?*_]+$/, '')

/** First http(s) URL in the text, without trailing punctuation or Markdown brackets. */
export function firstUrl(text: string): string | null {
  const m = new RegExp(URL_RE.source).exec(text)
  return m ? clean(m[0]) : null
}

/** Hosts of applicant tracking systems (an apply form, not a company home page or a benefits link). */
const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com)$/i

/**
 * The posting URL a job description names: its `Posting: <url>` line (written
 * by Huntgry's Jobs page), else the first URL on an ATS host, else the first
 * URL. A pasted description without a posting link otherwise picks up any
 * link in the text (#63).
 */
export function postingUrl(text: string): string | null {
  const line = /^\s*(?:\*\*)?posting(?:\*\*)?\s*:\s*(?:\*\*)?\s*(\S+)/im.exec(text)
  if (line) {
    const url = firstUrl(line[1])
    if (url) return url
  }
  for (const m of text.matchAll(URL_RE)) {
    try {
      if (ATS_HOST.test(new URL(clean(m[0])).hostname)) return clean(m[0])
    } catch {
      // Not a URL; keep looking.
    }
  }
  return firstUrl(text)
}

/** Reads the skill's `build-report.json`: `ok`, `verify.results[].passed`, `render.pages`. */
export function summarizeBuild(json: string | null): BuildSummary {
  if (!json) return { status: 'unknown', failed: [], warnings: 0, resumePages: null }
  try {
    const r = JSON.parse(json) as {
      ok?: unknown
      verify?: { results?: { check?: unknown; passed?: unknown; hard?: unknown }[]; warnings?: unknown }
      render?: { pages?: unknown }
      style_warnings?: unknown
    }
    const results = Array.isArray(r.verify?.results) ? r.verify.results : []
    const failed = results.filter((c) => c.passed === false && c.hard !== false).map((c) => String(c.check))
    const soft = results.filter((c) => c.passed === false && c.hard === false).length
    const style = Array.isArray(r.style_warnings) ? r.style_warnings.length : 0
    return {
      status: r.ok === true ? 'pass' : r.ok === false ? 'fail' : 'unknown',
      failed,
      warnings: soft + style,
      resumePages: typeof r.render?.pages === 'number' ? r.render.pages : null
    }
  } catch {
    return { status: 'unknown', failed: [], warnings: 0, resumePages: null }
  }
}

/**
 * Absolute path of an application folder from its id, confined to the
 * workspace and to the `<role>/<company>/<job-id>` shape.
 */
export function applicationFolder(workspace: string, id: string): string {
  const parts = id.split('/')
  if (parts.length !== APPLICATION_DEPTH || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) {
    throw new Error('Invalid application id.')
  }
  const folder = resolve(workspace, ...parts)
  if (!folder.startsWith(resolve(workspace) + sep)) throw new Error('Invalid application id.')
  return folder
}

/** Parses the URL into an application id and file name, or `null`. */
export function parseFileUrl(url: string): { id: string; file: string } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${FILE_SCHEME}:` || u.host !== 'app') return null
  let parts: string[]
  try {
    parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  if (parts.length !== 4 || parts.some((p) => p.includes('/') || p.includes('\\'))) return null
  return { id: parts.slice(0, 3).join('/'), file: parts[3] }
}
