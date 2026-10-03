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

/** The embed rule an https URL matches, or null. */
export function embedRuleFor(value: string): EmbedRule | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  return EMBED_RULES.find((r) => r.hosts.test(url.hostname) && r.path.test(url.pathname)) ?? null
}
