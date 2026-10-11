import type { ApplicationRecord } from '@shared/applications-types'
import type { Job } from '@shared/jobs-types'
import type { MasterProfile } from '@shared/master-profile'
import { AGENT_LABEL, type RunStatus, type RunSummary } from '@shared/runner-types'
import { locationOf, PAGE_LABEL, PAGES, SETTINGS_SECTION_LABEL, type Location, type NavPage, type SettingsSection } from '../../navigation'

/**
 * The ⌘K palette ("Sniff", #108): what it can find and how it ranks it. Pure, so the ranking is unit-tested;
 * `CommandPalette` draws the sections and runs the commands.
 */

export type PaletteGroup = 'jobs' | 'applications' | 'runs' | 'profile' | 'actions' | 'goto'

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  jobs: 'Jobs',
  applications: 'Applications',
  runs: 'Tailor runs',
  profile: 'In your profile',
  actions: 'Actions',
  goto: 'Go to'
}

/** Order of groups that score the same (and of the groups shown before anything is typed). */
const GROUP_ORDER: readonly PaletteGroup[] = ['jobs', 'applications', 'runs', 'profile', 'actions', 'goto']

/** Groups whose heading carries a count (`Jobs · 2`). */
const COUNTED: ReadonlySet<PaletteGroup> = new Set<PaletteGroup>(['jobs', 'applications', 'runs', 'profile'])

/** What choosing an entry does. */
export type PaletteCommand =
  | { kind: 'navigate'; location: Location }
  /** Readies the job (full posting, marked tailored) and opens the Tailor form on it. */
  | { kind: 'tailor-job'; job: Job }
  /** Starts auto-apply for an application (the Browser page shows the session). */
  | { kind: 'apply'; applicationId: string }
  | { kind: 'open-file'; applicationId: string; file: string }
  | { kind: 'reveal'; applicationId: string }
  | { kind: 'paste-job' }
  | { kind: 'toggle-theme' }
  | { kind: 'switch-workspace' }

/** Icon names; the component maps them to Tabler icons. */
export type PaletteIcon =
  | NavPage
  | 'graph'
  | 'skills'
  | 'queue'
  | 'job'
  | 'application'
  | 'run'
  | 'person'
  | 'project'
  | 'tailor'
  | 'world'
  | 'apply'
  | 'file'
  | 'folder'
  | 'paste'
  | 'theme'
  | 'workspace'
  | 'settings-section'

export interface PaletteItem {
  /** Unique across the palette. */
  id: string
  group: PaletteGroup
  title: string
  /** Second, quieter text on the same line (company, status, date…). Searched too. */
  subtitle?: string
  /** Extra words that find the entry but are not shown. */
  keywords?: string
  icon: PaletteIcon
  /** Shortcut shown at the end of the row (only real shortcuts). */
  shortcut?: string
  command: PaletteCommand
  /** Actions on this entry, offered in the Actions group while it is the best match. */
  actions?: PaletteItem[]
}

export interface PaletteSection {
  group: PaletteGroup
  label: string
  items: PaletteItem[]
}

/** Lower case, accents stripped, `·`/`→`/punctuation as spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .trim()
}

/** Characters of `token` appear in order within one word of `text` (a loose match, e.g. `tlr` → `tailor`). */
function subsequence(token: string, text: string): boolean {
  return text.split(' ').some((word) => {
    let i = 0
    for (const ch of word) if (ch === token[i] && ++i === token.length) return true
    return false
  })
}

/**
 * How well one query word matches a text: 100 at its start, 80 at the start of a later word, 50 inside a
 * word, 15 for its letters in order inside one word (three letters or more), else 0. Both arguments are normalized.
 */
export function wordScore(token: string, text: string): number {
  if (!token || !text) return 0
  const at = text.indexOf(token)
  if (at === 0) return 100
  if (at > 0) {
    // A word starts after a space; `.net` style tokens also count after any non-letter.
    let best = 50
    for (let i = at; i !== -1; i = text.indexOf(token, i + 1)) {
      if (i === 0 || text[i - 1] === ' ') {
        best = 80
        break
      }
    }
    return best
  }
  return token.length >= 3 && subsequence(token, text) ? 15 : 0
}

/**
 * Score of an entry for a query: every query word must match the title, subtitle or keywords; the title
 * counts most. 0 means no match. An empty query matches everything with 1.
 */
export function scoreItem(query: string, item: Pick<PaletteItem, 'title' | 'subtitle' | 'keywords'>): number {
  const q = normalize(query)
  if (!q) return 1
  const title = normalize(item.title)
  const subtitle = normalize(item.subtitle ?? '')
  const keywords = normalize(item.keywords ?? '')
  let total = 0
  const tokens = q.split(' ')
  for (const token of tokens) {
    const best = Math.max(wordScore(token, title), wordScore(token, subtitle) * 0.6, wordScore(token, keywords) * 0.5)
    if (best === 0) return 0
    total += best
  }
  let score = total / tokens.length
  if (title === q) score += 40
  else if (title.startsWith(q)) score += 20
  return score
}

export interface SearchOptions {
  /** Most entries per group (default 5; Go to shows up to 8). */
  limit?: number
}

/**
 * Groups the matching entries, best first. With a query, the best job or application lends its actions to
 * the Actions group (Tailor, Open posting, Apply), ahead of the general ones. Groups are ordered by their
 * best entry. Without a query: Go to, then Actions, then runs that are waiting for you or working.
 */
export function searchPalette(items: readonly PaletteItem[], query: string, options: SearchOptions = {}): PaletteSection[] {
  const limit = options.limit ?? 5
  const q = normalize(query)
  const byGroup = new Map<PaletteGroup, { item: PaletteItem; score: number; order: number }[]>()
  items.forEach((item, order) => {
    if (!q && !shownWithoutQuery(item)) return
    const score = scoreItem(q, item)
    if (score <= 0) return
    const list = byGroup.get(item.group) ?? []
    list.push({ item, score, order })
    byGroup.set(item.group, list)
  })
  for (const list of byGroup.values()) list.sort((a, b) => b.score - a.score || a.order - b.order)

  if (q) {
    // The best entity match brings its actions along.
    const entity = (['jobs', 'applications', 'runs'] as const)
      .map((g) => byGroup.get(g)?.[0])
      .filter((e): e is { item: PaletteItem; score: number; order: number } => e !== undefined && (e.item.actions?.length ?? 0) > 0)
      .sort((a, b) => b.score - a.score)[0]
    if (entity) {
      const actions = byGroup.get('actions') ?? []
      const lent = entity.item.actions!.map((item, i) => ({ item, score: entity.score, order: -100 + i }))
      byGroup.set('actions', [...lent, ...actions.map((a) => ({ ...a, score: Math.min(a.score, entity.score - 1) }))])
    }
  }

  const sections: (PaletteSection & { best: number })[] = []
  for (const group of GROUP_ORDER) {
    const list = byGroup.get(group)
    if (!list?.length) continue
    const max = group === 'goto' ? Math.max(limit, 8) : limit
    sections.push({
      group,
      label: COUNTED.has(group) ? `${GROUP_LABEL[group]} · ${list.length}` : GROUP_LABEL[group],
      items: list.slice(0, max).map((e) => e.item),
      best: q ? list[0].score : 0
    })
  }
  if (!q) {
    const rank: Partial<Record<PaletteGroup, number>> = { goto: 0, actions: 1, runs: 2 }
    sections.sort((a, b) => (rank[a.group] ?? 9) - (rank[b.group] ?? 9))
  } else {
    sections.sort((a, b) => b.best - a.best || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  }
  return sections.map(({ group, label, items: list }) => ({ group, label, items: list }))
}

/** Before anything is typed: the pages, the general actions and the runs that are live. */
function shownWithoutQuery(item: PaletteItem): boolean {
  if (item.group === 'actions') return true
  if (item.group === 'goto') return item.id.startsWith('page:')
  if (item.group === 'runs') return item.keywords?.includes('active') ?? false
  return false
}

/** Every entry of a search, in display order (for the arrow keys). */
export function flatten(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items)
}

// ---------------------------------------------------------------- entries

const PAGE_KEYWORDS: Record<NavPage, string> = {
  dashboard: 'home applications usage resumes',
  board: 'kanban columns to do applied interviewing offer archived',
  jobs: 'saved postings relevant scent',
  browser: 'tabs web posting apply',
  tailor: 'runs resume agent claude codex antigravity queue',
  review: 'unattended results approve',
  profile: 'master profile resume experience',
  settings: 'preferences agents pricing remote'
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped'
}

/** What the palette searches, loaded when it opens. */
export interface PaletteData {
  jobs: readonly Job[]
  applications: readonly ApplicationRecord[]
  runs: readonly RunSummary[]
  /** Applications waiting on the Review page. */
  reviewIds: ReadonlySet<string>
  profile: MasterProfile | null
  /** The scheme on screen, so "Switch theme" says where it goes. */
  scheme: 'light' | 'dark'
  /** `⌘` on macOS, `Ctrl` elsewhere. */
  mod: string
}

const nav = (location: Location): PaletteCommand => ({ kind: 'navigate', location })

function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' · ')
}

/** Every entry of the palette for `data`. */
export function paletteItems(data: PaletteData): PaletteItem[] {
  const items: PaletteItem[] = []

  // Go to: pages, Profile views, the queue, Settings sections.
  for (const page of PAGES) {
    items.push({ id: `page:${page}`, group: 'goto', title: PAGE_LABEL[page], keywords: PAGE_KEYWORDS[page], icon: page, command: nav(locationOf(page)) })
  }
  items.push(
    {
      id: 'view:graph',
      group: 'goto',
      title: 'Profile → Knowledge graph',
      keywords: 'graph skills nodes evidence',
      icon: 'graph',
      command: nav(locationOf('graph'))
    },
    { id: 'view:skills', group: 'goto', title: 'Profile → Skills', keywords: 'skills table evidence', icon: 'skills', command: nav(locationOf('profile', { view: 'skills' })) },
    { id: 'view:queue', group: 'goto', title: 'Tailor → Queue', keywords: 'bulk unattended pipeline', icon: 'queue', command: nav(locationOf('tailor', { view: 'queue' })) }
  )
  for (const [section, label] of Object.entries(SETTINGS_SECTION_LABEL) as [SettingsSection, string][]) {
    items.push({
      id: `settings:${section}`,
      group: 'goto',
      title: `Settings → ${label}`,
      keywords: section === 'appearance' ? 'theme dark light' : undefined,
      icon: 'settings-section',
      command: nav(locationOf('settings', { section }))
    })
  }

  // General actions.
  items.push(
    { id: 'action:tailor', group: 'actions', title: 'New tailored resume', keywords: 'tailor run start', icon: 'tailor', command: nav(locationOf('tailor')) },
    { id: 'action:paste', group: 'actions', title: 'Paste a job', keywords: 'add job description', icon: 'paste', command: { kind: 'paste-job' } },
    {
      id: 'action:theme',
      group: 'actions',
      title: 'Switch theme',
      subtitle: data.scheme === 'dark' ? 'to light' : 'to dark',
      keywords: 'dark light appearance mode',
      icon: 'theme',
      shortcut: `${data.mod} ⇧ L`,
      command: { kind: 'toggle-theme' }
    },
    { id: 'action:workspace', group: 'actions', title: 'Switch workspace', keywords: 'folder open', icon: 'workspace', command: { kind: 'switch-workspace' } }
  )

  // Applications first, so jobs can find theirs.
  const withResume = (a: ApplicationRecord) => a.files.includes('resume.pdf')
  const appItems = new Map<string, PaletteItem>()
  for (const app of data.applications) {
    const name = join(app.company, app.role) || app.id
    const inReview = data.reviewIds.has(app.id)
    const url = app.tracking.jobUrl ?? app.jobUrl
    const actions: PaletteItem[] = []
    if (withResume(app) && url) {
      actions.push({ id: `app-apply:${app.id}`, group: 'actions', title: 'Apply in browser', subtitle: name, icon: 'apply', command: { kind: 'apply', applicationId: app.id } })
    }
    if (url) actions.push({ id: `app-open:${app.id}`, group: 'actions', title: 'Open posting in Browser', subtitle: name, icon: 'world', command: nav(locationOf('browser', { url })) })
    if (withResume(app)) {
      actions.push({ id: `app-resume:${app.id}`, group: 'actions', title: 'Open the resume', subtitle: name, icon: 'file', command: { kind: 'open-file', applicationId: app.id, file: 'resume.pdf' } })
    }
    actions.push({ id: `app-folder:${app.id}`, group: 'actions', title: 'Show the folder', subtitle: name, icon: 'folder', command: { kind: 'reveal', applicationId: app.id } })
    const item: PaletteItem = {
      id: `app:${app.id}`,
      group: 'applications',
      title: name,
      subtitle: join(inReview ? 'Waiting for review' : app.tracking.status, shortDate(app.createdAt)),
      keywords: join(app.jobTitle, app.tracking.notes),
      icon: 'application',
      command: inReview
        ? nav(locationOf('review', { applicationId: app.id }))
        : withResume(app)
          ? { kind: 'open-file', applicationId: app.id, file: 'resume.pdf' }
          : { kind: 'reveal', applicationId: app.id },
      actions
    }
    appItems.set(app.id, item)
    items.push(item)
  }

  for (const job of data.jobs) {
    const name = join(job.company, job.title) || job.title || job.url
    const app = data.applications.find((a) => (a.jobId && (a.jobId === job.sourceId || a.jobId === job.id)) || (job.url && (a.tracking.jobUrl ?? a.jobUrl) === job.url))
    const apply = app ? appItems.get(app.id)?.actions?.find((a) => a.command.kind === 'apply') : undefined
    const actions: PaletteItem[] = [
      {
        id: `job-tailor:${job.id}`,
        group: 'actions',
        title: `Tailor a resume for ${job.company || job.title}…`,
        icon: 'tailor',
        command: { kind: 'tailor-job', job }
      }
    ]
    if (job.url) actions.push({ id: `job-open:${job.id}`, group: 'actions', title: 'Open posting in Browser', subtitle: name, icon: 'world', command: nav(locationOf('browser', { url: job.url })) })
    if (apply) actions.push({ ...apply, id: `job-apply:${job.id}` })
    items.push({
      id: `job:${job.id}`,
      group: 'jobs',
      title: name,
      subtitle: join(job.location, job.remote && !/remote/i.test(job.location) && 'Remote'),
      keywords: join(job.tags.join(' '), job.source),
      icon: 'job',
      command: job.url ? nav(locationOf('browser', { url: job.url })) : { kind: 'tailor-job', job },
      actions
    })
  }

  // Newest runs first.
  const runs = [...data.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const run of runs) {
    const live = run.status === 'running' || run.status === 'waiting'
    items.push({
      id: `run:${run.id}`,
      group: 'runs',
      title: run.title,
      subtitle: join(RUN_STATUS_LABEL[run.status], AGENT_LABEL[run.agent], shortDate(run.updatedAt)),
      keywords: join(run.params.company, run.params.role, live && 'active'),
      icon: 'run',
      command: nav(locationOf('tailor', { runId: run.id }))
    })
  }

  // The master profile: roles, projects, skills.
  const profile = data.profile
  if (profile) {
    profile.experience.forEach((e, i) => {
      if (!e.company && !e.role) return
      const dates = [e.start, e.end].filter(Boolean).join('–')
      items.push({
        id: `profile-role:${i}`,
        group: 'profile',
        title: `${join(e.company, e.role)}${dates ? ` (${dates})` : ''}`,
        subtitle: 'in your profile',
        keywords: join(e.technologies, e.location),
        icon: 'person',
        command: nav(locationOf('profile', { section: 'experience' }))
      })
    })
    profile.projects.forEach((p, i) => {
      if (!p.name) return
      items.push({
        id: `profile-project:${i}`,
        group: 'profile',
        title: p.name,
        subtitle: 'project in your profile',
        keywords: p.technologies,
        icon: 'project',
        command: nav(locationOf('profile', { section: 'projects' }))
      })
    })
    const skills = new Set<string>()
    for (const g of profile.skills) for (const s of g.items) if (s.trim()) skills.add(s.trim())
    for (const skill of skills) {
      items.push({
        id: `profile-skill:${skill.toLowerCase()}`,
        group: 'profile',
        title: skill,
        subtitle: 'skill in your profile',
        icon: 'skills',
        command: nav(locationOf('profile', { view: 'skills' }))
      })
    }
  }

  return items
}
