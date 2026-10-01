import type { Job } from '@shared/jobs-types'
import { money } from '../text'

/**
 * hiring.cafe (hiringcafe.com). The site is a Next.js app behind Cloudflare,
 * so plain HTTP gets a 403; the search page is loaded in a hidden browser
 * window instead and its own server-rendered data (`__NEXT_DATA__`,
 * `pageProps.ssrHits`) is read. Search results carry a structured summary,
 * not the full posting; the full text comes from the employer's page
 * (`apply_url`).
 */

export const HIRINGCAFE_ORIGIN = 'https://hiringcafe.com'

export function hiringCafeSearchUrl(
  q: { keywords: string; location: string; remoteOnly: boolean },
  origin: string = HIRINGCAFE_ORIGIN
): string {
  // Location in the free-text query narrows results to near nothing; `matchesLocation` applies it instead.
  const state: Record<string, unknown> = {
    searchQuery: q.keywords.trim()
  }
  if (q.remoteOnly) state.workplaceTypes = ['Remote']
  return `${origin}/?searchState=${encodeURIComponent(JSON.stringify(state))}`
}

/**
 * Whether a job fits the searched location: remote jobs always do; otherwise
 * the city (first part of "Atlanta, GA") must appear in the job's location.
 */
export function matchesLocation(job: { location: string; remote: boolean }, location: string): boolean {
  const city = location.split(',')[0].trim().toLowerCase()
  return !city || job.remote || job.location.toLowerCase().includes(city)
}

/** Runs in the page: returns the raw search hits (or `null` when the data is missing). */
export const HIRINGCAFE_EXTRACT = `(() => {
  const p = window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps
  if (!p || !Array.isArray(p.ssrHits)) return null
  // The first render can carry no hits before the search settles; mark it provisional.
  return JSON.stringify({ hits: p.ssrHits, total: p.ssrTotalCount ?? null, empty: p.ssrHits.length === 0 })
})()`

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseHiringCafeHits(data: unknown, now = new Date()): Job[] {
  const hits = Array.isArray(obj(data).hits) ? (obj(data).hits as unknown[]) : []
  const jobs: Job[] = []
  for (const raw of hits) {
    const h = obj(raw)
    const id = str(h.id) || str(h.objectID)
    const v5 = obj(h.v5_processed_job_data)
    const title = str(obj(h.job_information).title) || str(v5.core_job_title)
    const url = str(h.apply_url)
    if (!id || !title || h.is_expired === true) continue
    const workplace = str(v5.workplace_type)
    const min = typeof v5.yearly_min_compensation === 'number' ? v5.yearly_min_compensation : null
    const max = typeof v5.yearly_max_compensation === 'number' ? v5.yearly_max_compensation : null
    const currency = str(v5.listed_compensation_currency) || 'USD'
    const salary =
      min && max
        ? `${money(min, currency)} – ${money(max, currency)} / year`
        : min
          ? `from ${money(min, currency)} / year`
          : ''
    const summary = [
      str(v5.requirements_summary) && `Requirements: ${str(v5.requirements_summary)}`,
      strs(v5.role_activities).length > 0 && `Responsibilities: ${strs(v5.role_activities).join('; ')}`,
      strs(v5.technical_tools).length > 0 && `Technologies: ${strs(v5.technical_tools).join(', ')}`,
      [str(v5.seniority_level), str(v5.role_type), strs(v5.commitment).join(', ')].filter(Boolean).join(' · ')
    ].filter(Boolean)
    jobs.push({
      id: `hiring.cafe:${id}`,
      source: 'hiring.cafe',
      sourceId: id,
      title,
      company: str(obj(h.enriched_company_data).name) || str(v5.company_name),
      location: str(v5.formatted_workplace_location),
      remote: /remote/i.test(workplace),
      salary,
      postedAt: str(v5.estimated_publish_date) || null,
      url: url || `${HIRINGCAFE_ORIGIN}/`,
      boardUrl: null,
      description: summary.join('\n\n'),
      descriptionComplete: false,
      tags: strs(v5.technical_tools),
      fetchedAt: now.toISOString()
    })
  }
  return jobs
}
