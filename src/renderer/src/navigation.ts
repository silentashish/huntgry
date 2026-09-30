import type { AgentId, JobSourceTag } from '@shared/runner-types'
import { createContext, useContext } from 'react'

/**
 * In-app navigation: a page name plus typed parameters. No router library,
 * no URLs; pages open each other with `navigate(page, params)`.
 */

/** Parameters each page accepts. Add a page here, then add it to `PAGES` and the shell. */
export interface PageParams {
  dashboard: undefined
  jobs: undefined
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
      }
    | undefined
  graph: { nodeId?: string } | undefined
  profile: { section?: ProfileSection } | undefined
  settings: undefined
}

export type Page = keyof PageParams

/** Tabs of the master profile editor, used to deep-link into a section. */
export type ProfileSection = 'contact' | 'summary' | 'experience' | 'projects' | 'education' | 'credentials' | 'notes'

/** Where the app is: a page and the parameters it was opened with. */
export type Location = { [P in Page]: { page: P; params: PageParams[P] } }[Page]

/** Navbar order. */
export const PAGES: readonly Page[] = ['dashboard', 'jobs', 'browser', 'tailor', 'graph', 'profile', 'settings']

/** Pages drawn edge to edge, without the shell's padding and max width. */
export const FULL_BLEED: ReadonlySet<Page> = new Set<Page>(['browser'])

export const DEFAULT_LOCATION: Location = { page: 'dashboard', params: undefined }

/** Builds a location; params are optional only for pages whose params may be `undefined`. */
export function locationOf<P extends Page>(
  page: P,
  ...params: undefined extends PageParams[P] ? [PageParams[P]?] : [PageParams[P]]
): Location {
  return { page, params: params[0] } as Location
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
