import type { BoardColumnId } from '@shared/board'
import type { AgentId, JobSourceTag } from '@shared/runner-types'
import { createContext, useContext } from 'react'

/**
 * In-app navigation: a page name plus typed parameters. No router library,
 * no URLs; pages open each other with `navigate(page, params)`.
 */

/** Parameters each page accepts. Add a page here, then add it to `PAGES` and the shell. */
export interface PageParams {
  dashboard: undefined
  /**
   * Every job as a card, from To do to Archived (#85). Where applications are browsed since the
   * Dashboard table went (#161): `column` scrolls to that column and marks it, `applicationId`
   * opens that application's drawer.
   */
  board: { column?: BoardColumnId; applicationId?: string } | undefined
  /**
   * `reload` (any new value) draws the page afresh, e.g. after the palette's "Paste a job" saved one;
   * `openId` opens that saved job's drawer (Explore's "Added", #142).
   */
  jobs: { reload?: number; openId?: string } | undefined
  /** Jobright's daily new-grad list, grouped by posted day; rows are added to Jobs (#142). */
  explore: undefined
  /** Opens `url` in an in-app browser tab (or shows the open tabs when absent). */
  browser: { url?: string } | undefined
  /** Pre-fills the Tailor form, e.g. from a job found on the Jobs page. */
  tailor:
    | {
        jobDescription?: string
        jobUrl?: string
        company?: string
        role?: string
        jobId?: string
        /** Job board the job came from, recorded with the application. */
        source?: JobSourceTag
        /** `false` when `jobDescription` is only the board's summary, so the form can say so. */
        descriptionComplete?: boolean
        /** Open on the bulk tailoring queue (after "Tailor all" on the Jobs page). */
        view?: 'queue'
        /** Preselect this agent instead of the default one. */
        agent?: AgentId
        /** Open this run (from the Dashboard's usage figures). */
        runId?: string
        /** The saved job the form was filled from (#158): Start queues that job instead of saving a new one. */
        savedJobId?: string
      }
    | undefined
  /** Unattended results to review (#31); opens on one application when given. */
  review: { applicationId?: string } | undefined
  /** Automation (#154): high-match jobs prepared unattended up to Submit; `key` highlights one candidate. */
  automation: { key?: string } | undefined
  /**
   * The Knowledge graph lives in Profile now (#95, #108). Kept so callers can still `navigate('graph', …)`:
   * `locationOf` turns it into `profile` with `{ view: 'graph', nodeId }`, so no location is ever on `graph`.
   */
  graph: { nodeId?: string } | undefined
  /**
   * The master profile (#95: Profile absorbs the Knowledge graph). `view` picks the Editor, the
   * Knowledge graph or the Skills table (Editor when absent); `section` deep-links into an Editor
   * section and `nodeId` selects a graph node (graph view).
   */
  profile: { view?: ProfileView; section?: ProfileSection; nodeId?: string } | undefined
  /** `section` asks Settings to show one of its sections (the ⌘K palette's "Settings → …" entries). */
  settings: { section?: SettingsSection } | undefined
}

export type Page = keyof PageParams

/** Views of the Profile page. */
export type ProfileView = 'editor' | 'graph' | 'skills'

/** Sections of the Settings page, in its section nav order (Figma Settings 14:2). */
export type SettingsSection =
  | 'agents'
  | 'reframing-rules'
  | 'saved-answers'
  | 'pricing'
  | 'claude'
  | 'skill-dependencies'
  | 'jobright'
  | 'remote-control'
  | 'appearance'
  | 'about'

/** Tabs of the master profile editor, used to deep-link into a section. */
export type ProfileSection =
  | 'contact'
  | 'summary'
  | 'experience'
  | 'projects'
  | 'education'
  | 'credentials'
  | 'notes'
  /** The one-time application answers (#136), stored outside master-profile.md. */
  | 'application'

/** Where the app is: a page and the parameters it was opened with. */
export type Location = { [P in Page]: { page: P; params: PageParams[P] } }[Page]

/** Pages with an entry in the sidebar; `graph` is a view of Profile (#95). */
export type NavPage = Exclude<Page, 'graph'>

/** Navbar order: 10 entries (the Knowledge graph moved into Profile; Explore follows Jobs, #142; Automation follows Review, #154). */
export const PAGES: readonly NavPage[] = [
  'dashboard',
  'board',
  'jobs',
  'explore',
  'browser',
  'tailor',
  'review',
  'automation',
  'profile',
  'settings'
]

/** Sidebar and palette label of each page (#108: "Master profile" is now "Profile"). */
export const PAGE_LABEL: Record<NavPage, string> = {
  dashboard: 'Dashboard',
  board: 'Board',
  jobs: 'Jobs',
  explore: 'Explore',
  browser: 'Browser',
  tailor: 'Tailor',
  review: 'Review',
  automation: 'Automation',
  profile: 'Profile',
  settings: 'Settings'
}

/** Settings section names, as its section nav shows them. */
export const SETTINGS_SECTION_LABEL: Record<SettingsSection, string> = {
  agents: 'Agents',
  'reframing-rules': 'Reframing rules',
  'saved-answers': 'Saved answers',
  pricing: 'Pricing',
  claude: 'Claude',
  'skill-dependencies': 'Skill dependencies',
  jobright: 'Jobright',
  'remote-control': 'Remote control',
  appearance: 'Appearance',
  about: 'About'
}

/** Pages drawn edge to edge, without the shell's padding and max width. */
export const FULL_BLEED: ReadonlySet<Page> = new Set<Page>(['browser'])

/** Pages that keep the shell's padding but drop its max width, to use the whole window (#90). */
export const WIDE: ReadonlySet<Page> = new Set<Page>(['board'])

export const DEFAULT_LOCATION: Location = { page: 'dashboard', params: undefined }

/**
 * Where a location really opens: `graph` (the old Knowledge graph page) becomes Profile's graph view,
 * keeping the selected node. Every other location is returned as is.
 */
export function redirect(location: Location): Location {
  if (location.page !== 'graph') return location
  const nodeId = location.params?.nodeId
  return { page: 'profile', params: nodeId ? { view: 'graph', nodeId } : { view: 'graph' } }
}

/**
 * Builds a location (after `redirect`); params are optional only for pages whose params may be `undefined`.
 */
export function locationOf<P extends Page>(
  page: P,
  ...params: undefined extends PageParams[P] ? [PageParams[P]?] : [PageParams[P]]
): Location {
  return redirect({ page, params: params[0] } as Location)
}

/** Parameters of `location` when it is on `page`, else `undefined`. */
export function paramsFor<P extends Page>(location: Location, page: P): PageParams[P] | undefined {
  return location.page === page ? (location.params as PageParams[P]) : undefined
}

export interface Navigation {
  location: Location
  navigate<P extends Page>(page: P, ...params: undefined extends PageParams[P] ? [PageParams[P]?] : [PageParams[P]]): void
  /**
   * A page with unsaved work registers a message; navigating away (or switching
   * workspace) then asks for confirmation first. Pass `null` to clear.
   */
  setLeaveGuard(message: string | null): void
}

export const NavigationContext = createContext<Navigation | null>(null)

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext)
  if (!nav) throw new Error('useNavigation must be used inside the app shell.')
  return nav
}
