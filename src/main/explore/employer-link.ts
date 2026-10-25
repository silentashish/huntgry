import type { JobrightAccount } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import type { AppSettings } from '../workspace/settings'
import type { Loader } from '../jobs/service'
import { findCanonical, readJob, saveJob } from '../jobs/store'
import { JOBRIGHT_HOSTS, jobrightId } from './parse'

/**
 * The employer's own posting for a Jobright job (#146). A Jobright posting page (`/jobs/info/<id>`) is a
 * Next.js page: `__NEXT_DATA__` → `props.pageProps.logined` says whether it was rendered for a signed-in
 * user, and only then does `dataSource.jobResult` carry `applyLink` / `originalUrl`, the posting on the
 * employer's site or ATS. Huntgry reads them from the hidden job-board browser, whose session the user
 * signs in to once from Settings, and replaces the saved job's Jobright link with the employer's.
 */

/**
 * Loader expression: `{ logined, applyLink, originalUrl }` from the page's `__NEXT_DATA__`; `logined` is
 * `null` on a page without it (not a Jobright posting page). `null` while the page is still loading.
 */
export const JOBRIGHT_PAGE_EXTRACT = `(() => {
  const el = document.getElementById('__NEXT_DATA__')
  if (!el) return document.readyState === 'complete' ? JSON.stringify({ logined: null, applyLink: null, originalUrl: null }) : null
  try {
    const pp = (JSON.parse(el.textContent || '{}').props || {}).pageProps || {}
    const job = (pp.dataSource || {}).jobResult || {}
    const str = (v) => (typeof v === 'string' ? v : null)
    return JSON.stringify({ logined: typeof pp.logined === 'boolean' ? pp.logined : null, applyLink: str(job.applyLink), originalUrl: str(job.originalUrl) })
  } catch {
    return JSON.stringify({ logined: null, applyLink: null, originalUrl: null })
  }
})()`

export interface JobrightPage {
  logined: boolean | null
  applyLink: string | null
  originalUrl: string | null
}

/** The extract's result, shape-checked: it comes from a web page. */
export function jobrightPageOf(data: unknown): JobrightPage {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 4000 ? v : null)
  return {
    logined: typeof d.logined === 'boolean' ? d.logined : null,
    applyLink: str(d.applyLink),
    originalUrl: str(d.originalUrl)
  }
}

const MAX_URL = 2000

/**
 * The employer link of a page: `applyLink`, else `originalUrl`, when it is an http(s) URL without
 * credentials on a host that is not Jobright's (`jobrightHosts`, plus any `*.jobright.ai`). Jobright's
 * `utm_*` parameters are dropped; everything else is kept (an ATS may need its own query). The public-URL
 * guard runs on it before it is saved.
 */
export function employerLink(page: JobrightPage, jobrightHosts: readonly string[] = JOBRIGHT_HOSTS): string | null {
  for (const candidate of [page.applyLink, page.originalUrl]) {
    if (!candidate) continue
    let u: URL
    try {
      u = new URL(candidate.trim())
    } catch {
      continue
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    if (u.username || u.password) continue
    const host = u.host.toLowerCase()
    if (jobrightHosts.includes(host) || u.hostname.toLowerCase() === 'jobright.ai' || u.hostname.toLowerCase().endsWith('.jobright.ai'))
      continue
    for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key)
    const url = u.toString()
    if (url.length <= MAX_URL) return url
  }
  return null
}

/** The account state stored with the app settings. */
export function accountOf(settings: AppSettings): JobrightAccount {
  const j = settings.jobright ?? {}
  return {
    connected: typeof j.connected === 'boolean' ? j.connected : null,
    checkedAt: typeof j.checkedAt === 'string' ? j.checkedAt : null
  }
}

export interface LinkDeps {
  /** The hidden job-board loader (`loadAndExtract`), a stub in tests. */
  load: Loader
  /** Hosts of Jobright posting pages (jobright.ai, plus the e2e mock's). */
  hosts: readonly string[]
  /** Why a URL may not be saved (the public-URL guard), or `null`. */
  refusal(url: string): Promise<string | null>
  /** Called with `logined` whenever a loaded page reports it, to keep the account state current. */
  onLogin(logined: boolean): Promise<void>
}

export type LinkOutcome = 'resolved' | 'signed-out' | 'no-link' | 'failed' | 'skipped'

/** The Jobright page to load for a saved job: its board link, or its link while that is still Jobright's. */
function jobrightPageUrl(job: Job, hosts: readonly string[]): string | null {
  for (const url of [job.boardUrl, job.url]) if (url && jobrightId(url, hosts)) return url
  return null
}

/**
 * Loads a saved `jobright` job's Jobright page and, when it gives an employer link, saves that as the
 * job's `url` (`boardUrl` stays the Jobright page). `skipped` when the job is not a Jobright job or its
 * link is no longer Jobright's. Never throws: the job keeps its Jobright link on any failure.
 */
export async function resolveEmployerLink(
  workspace: string,
  savedId: string,
  deps: LinkDeps
): Promise<{ outcome: LinkOutcome; job: Job | null }> {
  const raw = await readJob(workspace, savedId)
  if (!raw || raw.source !== 'jobright' || !jobrightId(raw.url, deps.hosts)) return { outcome: 'skipped', job: raw }
  const page = jobrightPageUrl(raw, deps.hosts)
  if (!page) return { outcome: 'skipped', job: raw }
  let data: JobrightPage
  try {
    const res = await deps.load(page, JOBRIGHT_PAGE_EXTRACT)
    if (res.status !== 'ok') return { outcome: 'failed', job: raw }
    data = jobrightPageOf(res.data)
  } catch {
    return { outcome: 'failed', job: raw }
  }
  if (data.logined !== null) await deps.onLogin(data.logined).catch(() => undefined)
  const link = employerLink(data, deps.hosts)
  if (!link) return { outcome: data.logined === false ? 'signed-out' : 'no-link', job: raw }
  if (await deps.refusal(link)) return { outcome: 'failed', job: raw }
  const saved = await saveJob(workspace, { ...raw, url: link, boardUrl: raw.boardUrl ?? page })
  return { outcome: 'resolved', job: (await findCanonical(workspace, saved.id)) ?? saved }
}

/**
 * Resolves every Jobright copy of a saved job (the canonical record and its aliases), e.g. before its full
 * description is fetched. Returns whether any link changed; `onOutcome` hears each copy's outcome.
 */
export async function resolveJobrightCopies(
  workspace: string,
  id: string,
  deps: LinkDeps,
  onOutcome?: (outcome: LinkOutcome) => void
): Promise<boolean> {
  const canonical = await findCanonical(workspace, id)
  if (!canonical) return false
  let changed = false
  for (const copyId of [canonical.id, ...(canonical.aliases ?? [])]) {
    if (!copyId.startsWith('jobright:')) continue
    const { outcome } = await resolveEmployerLink(workspace, copyId, deps)
    // Automation (#154) tells a failed lookup from "no link given".
    onOutcome?.(outcome)
    if (outcome === 'resolved') changed = true
  }
  return changed
}
