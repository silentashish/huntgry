import type { ApplyAts } from './apply-types'

/**
 * Where to apply for a posting, and which ATS serves it. Pure, so it is
 * shared by main (opening the tab) and the guest page (choosing an adapter).
 */

const GREENHOUSE_HOST = /(^|\.)greenhouse\.io$/i
const LEVER_HOST = /(^|\.)lever\.co$/i
const ASHBY_HOST = /(^|\.)ashbyhq\.com$/i

/** The ATS an address belongs to by host alone (`generic` when unknown). */
export function atsForHost(host: string): ApplyAts {
  if (GREENHOUSE_HOST.test(host)) return 'greenhouse'
  if (LEVER_HOST.test(host)) return 'lever'
  return 'generic'
}

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
  // jobs.lever.co/<company>/<posting-id>[/apply]
  if (LEVER_HOST.test(url.hostname) && parts.length === 2) parts.push('apply')
  // jobs.ashbyhq.com/<company>/<posting-id>[/application]
  if (ASHBY_HOST.test(url.hostname) && parts.length === 2) parts.push('application')
  url.pathname = `/${parts.join('/')}`
  url.hash = ''
  return url.href
}

/** A Greenhouse embedded-form URL (`…greenhouse.io/embed/job_app?…`), safe to open in the tab directly. */
export function isGreenhouseEmbedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && GREENHOUSE_HOST.test(url.hostname) && url.pathname === '/embed/job_app'
  } catch {
    return false
  }
}
