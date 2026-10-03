import type { ApplyAts } from './apply-types'

/**
 * ATS forms that company careers pages embed in an iframe. The tab's preload
 * runs in the top frame only, so main opens a matching iframe URL in the tab
 * directly. DOM-free: used by the page engine (finding the iframe) and by main
 * (checking the URL before navigating). To support another ATS's embed, add
 * one entry.
 */
export interface EmbedRule {
  ats: ApplyAts
  /** CSS selector of the iframe on the host page. */
  iframe: string
  /** Hosts the embedded form is served from (https only). */
  hosts: RegExp
  /** Path of the embedded form. */
  path: RegExp
}

export const EMBED_RULES: readonly EmbedRule[] = [
  // `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>` (or `validityToken=`, short-lived).
  { ats: 'greenhouse', iframe: 'iframe[src*="/embed/job_app"]', hosts: /(^|\.)greenhouse\.io$/i, path: /^\/embed\/job_app$/ }
]

export const embedPathMatches = (rule: EmbedRule, url: URL): boolean => rule.path.test(url.pathname)

const isLoopbackHost = (host: string) => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/**
 * The embed rule a URL matches: an https URL on the rule's hosts, or, with
 * `allowLoopback` (dev builds testing against the local mock ATS only), an
 * http(s) loopback URL with the rule's path. Null otherwise.
 */
export function embedRuleFor(value: string, { allowLoopback = false } = {}): EmbedRule | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const local = allowLoopback && /^https?:$/.test(url.protocol) && isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !local) return null
  return EMBED_RULES.find((r) => (local || r.hosts.test(url.hostname)) && embedPathMatches(r, url)) ?? null
}
