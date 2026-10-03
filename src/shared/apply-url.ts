import { embedRuleFor } from './apply-embeds'
import type { ApplyAts } from './apply-types'

/**
 * Where to apply for a posting, and which ATS serves it. Pure, so it is
 * shared by main (opening the tab) and the guest page (choosing an adapter).
 */

const GREENHOUSE_HOST = /(^|\.)greenhouse\.io$/i
const LEVER_HOST = /(^|\.)lever\.co$/i
const ASHBY_HOST = /(^|\.)ashbyhq\.com$/i
const WORKDAY_HOST = /(^|\.)myworkday(jobs|site)\.com$/i

/** The ATS an address belongs to by host alone (`generic` when unknown). */
export function atsForHost(host: string): ApplyAts {
  if (GREENHOUSE_HOST.test(host)) return 'greenhouse'
  if (LEVER_HOST.test(host)) return 'lever'
  if (ASHBY_HOST.test(host)) return 'ashby'
  if (WORKDAY_HOST.test(host)) return 'workday'
  return 'generic'
}

/**
 * ATS hosts trusted for auto-fill on any https page, even off the posting's
 * own origin (a company page linking to its Greenhouse board). An ATS joins
 * this set when its adapter has been verified on live markup.
 */
export const AUTO_TRUSTED_ATS: ReadonlySet<ApplyAts> = new Set<ApplyAts>(['greenhouse', 'lever', 'ashby'])

/**
 * The page with the application form for a posting URL: Lever and Ashby put it
 * on `<posting>/apply` and `<posting>/application`; Greenhouse and everything
 * else show it on the posting itself. Idempotent; query strings are kept.
 * Throws for anything but http(s).
 */
export function applyUrlFor(jobUrl: string): string {
  let url: URL
  try {
    url = new URL(jobUrl.trim())
  } catch {
    throw new Error('The posting URL is not valid.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The posting URL must be http(s).')
  const parts = url.pathname.split('/').filter(Boolean)
  // jobs.lever.co/<company>/<posting-id>[/apply], jobs.ashbyhq.com/<company>/<posting-id>[/application]
  const page = LEVER_HOST.test(url.hostname) ? 'apply' : ASHBY_HOST.test(url.hostname) ? 'application' : null
  // Other paths are left exactly as they are (some sites care about a trailing slash).
  if (page && parts.length === 2) url.pathname = `/${[...parts, page].join('/')}`
  url.hash = ''
  return url.href
}

/**
 * Whether Huntgry may fill `pageUrl` on its own during an apply session: one
 * of the session's trusted origins (`trusted`: the posting URL, or the URLs /
 * origins the session trusts, such as where the posting's own redirects
 * landed), or a Greenhouse / Lever / Ashby host over https. Anything else (a page the
 * user clicked to, a page that merely looks like an ATS form) waits for the
 * user to press Fill form.
 */
export function isTrustedApplyPage(pageUrl: string, trusted: string | readonly string[]): boolean {
  try {
    const page = new URL(pageUrl)
    for (const entry of typeof trusted === 'string' ? [trusted] : trusted) {
      try {
        if (entry && page.origin === new URL(entry).origin) return true
      } catch {
        // Not a URL; skip it.
      }
    }
    return page.protocol === 'https:' && AUTO_TRUSTED_ATS.has(atsForHost(page.hostname))
  } catch {
    return false
  }
}

/** A Greenhouse embedded-form URL (`…greenhouse.io/embed/job_app?…`), safe to open in the tab directly. */
export function isGreenhouseEmbedUrl(value: string): boolean {
  return embedRuleFor(value)?.ats === 'greenhouse'
}
